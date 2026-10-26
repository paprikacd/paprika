package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

const maxSavedQueryBytes = 32 << 10

type SavedQuery struct {
	SchemaVersion int                   `json:"schemaVersion"`
	ID            string                `json:"id"`
	Name          string                `json:"name"`
	Description   string                `json:"description,omitempty"`
	ImageURL      string                `json:"imageUrl,omitempty"`
	Tags          []string              `json:"tags,omitempty"`
	Metadata      map[string]string     `json:"metadata,omitempty"`
	ProviderID    string                `json:"providerId"`
	Kind          string                `json:"kind"`
	Query         string                `json:"query"`
	Parameters    []SavedQueryParameter `json:"parameters,omitempty"`
}

type SavedQueryParameter struct {
	Name         string          `json:"name"`
	Label        string          `json:"label,omitempty"`
	Type         string          `json:"type"`
	DefaultValue json.RawMessage `json:"defaultValue,omitempty"`
}

func validateSavedQuery(id string, raw json.RawMessage) (SavedQuery, error) {
	var query SavedQuery
	if !validID.MatchString(id) || len(raw) > maxSavedQueryBytes {
		return query, errors.New("saved query id or size is invalid")
	}
	fields, err := requireObjectShape(raw, []string{"schemaVersion", "id", "name", "providerId", "kind", "query"}, []string{"description", "imageUrl", "tags", "metadata", "parameters"})
	if err != nil {
		return query, err
	}
	if decodeErr := decodeSavedQuery(raw, id, &query); decodeErr != nil {
		return query, decodeErr
	}
	if metadataErr := validateSavedQueryPresentation(fields, &query); metadataErr != nil {
		return query, metadataErr
	}
	types, err := savedQueryParameterTypes(fields)
	if err != nil {
		return query, err
	}
	if err := validateSavedQueryTemplate(trimJS(query.Query), types); err != nil {
		return query, err
	}
	return query, nil
}

func validSavedQueryImageURL(value string) bool {
	if value == "" || stringUnits(value) > 2048 {
		return false
	}
	if !validImageURLCharacters(value) {
		return false
	}
	if strings.HasPrefix(value, "/") {
		return !strings.HasPrefix(value, "//")
	}
	if !strings.HasPrefix(value, "https://") {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil {
		return false
	}
	return validImageURLPort(parsed.Port())
}

func validateQueryLiteral(raw json.RawMessage, kind string) error {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return errors.New("query values must be bounded strings or finite numbers")
	}
	switch v := value.(type) {
	case string:
		if kind != "number" && stringUnits(v) <= 1024 {
			return nil
		}
	case float64:
		if kind != "string" && finite(v) {
			return nil
		}
	}
	return errors.New("query values must match their parameter type: strings up to 1024 characters or finite numbers")
}

// Mirror the frontend literal interpolator: placeholders cannot occur in quoted
// strings, comments, or token fragments, and numeric literals allow @ adjacency.
// This validates template structure; it neither executes nor parses PromQL/TraceQL.
type queryTemplateState struct {
	quote   rune
	comment string
	escaped bool
}

func validateSavedQueryTemplate(query string, types map[string]string) error {
	text := []rune(query)
	state := queryTemplateState{}
	for i := 0; i < len(text); i++ {
		char := text[i]
		var next rune
		if i+1 < len(text) {
			next = text[i+1]
		}
		if char == '{' && next == '{' {
			end, err := validateTemplatePlaceholder(text, i, types, state)
			if err != nil {
				return err
			}
			i = end + 1
			continue
		}
		if state.advance(char, next) {
			i++
		}
	}
	return nil
}

func validateTemplatePlaceholder(text []rune, start int, types map[string]string, state queryTemplateState) (int, error) {
	end := start + 2
	for end+1 < len(text) && (text[end] != '}' || text[end+1] != '}') {
		end++
	}
	if end+1 >= len(text) {
		return 0, errors.New("finish the query parameter placeholder with }}")
	}
	name := string(text[start+2 : end])
	if !validVariableName(name) || types[name] == "" {
		return 0, fmt.Errorf("query placeholder %q must name a declared parameter", name)
	}
	if state.quote != 0 || state.comment != "" {
		return 0, errors.New("query parameters must be whole unquoted literals outside comments")
	}
	if !validPlaceholderBoundaries(text, start, end, types[name]) {
		return 0, errors.New("query parameters must be complete literal values, not token fragments")
	}
	return end, nil
}

func validPlaceholderBoundaries(text []rune, start, end int, kind string) bool {
	before := "(=~!<>:,|&"
	if kind == "number" {
		before += "+-*/%^@"
	}
	return (start == 0 || literalBoundary(text[start-1], before)) && (end+2 >= len(text) || literalBoundary(text[end+2], ",})]|&!<>=:+-*/%^"))
}

func (s *queryTemplateState) advance(char, next rune) bool {
	switch s.comment {
	case "line":
		if char == '\n' || char == '\r' {
			s.comment = ""
		}
		return false
	case "block":
		if char == '*' && next == '/' {
			s.comment = ""
			return true
		}
		return false
	}
	if s.quote != 0 {
		s.advanceQuote(char)
		return false
	}
	return s.startLiteral(char, next)
}

func (s *queryTemplateState) advanceQuote(char rune) {
	if s.quote != '`' && s.escaped {
		s.escaped = false
	} else if s.quote != '`' && char == '\\' {
		s.escaped = true
	} else if char == s.quote {
		s.quote = 0
	}
}

func (s *queryTemplateState) startLiteral(char, next rune) bool {
	if char == '"' || char == '\'' || char == '`' {
		s.quote = char
	} else if char == '#' || (char == '/' && next == '/') {
		s.comment = "line"
	} else if char == '/' && next == '*' {
		s.comment = "block"
		return true
	}
	return false
}

func literalBoundary(char rune, punctuation string) bool {
	// ECMAScript \s also includes BOM, but excludes Unicode NEL.
	return char == '\ufeff' || (char != '\u0085' && unicode.IsSpace(char)) || strings.ContainsRune(punctuation, char)
}

func validateQueryReference(raw json.RawMessage, tooltip bool) error {
	fields, err := requireObjectShape(raw, []string{"id"}, []string{"bindings"})
	if err != nil {
		return err
	}
	var id string
	if json.Unmarshal(fields["id"], &id) != nil || !validID.MatchString(id) {
		return errors.New("saved query references require a valid id")
	}
	if rawBindings, ok := fields["bindings"]; ok {
		return validateQueryBindings(rawBindings, tooltip)
	}
	return nil
}

func validateSavedQueryTags(tags json.RawMessage) error {
	var values []any
	if json.Unmarshal(tags, &values) != nil || values == nil || len(values) > 12 {
		return errors.New("saved query tags must be an array of at most 12 unique strings")
	}
	seen := map[string]bool{}
	for _, item := range values {
		value, ok := item.(string)
		if !ok || value == "" || value != trimJS(value) || stringUnits(value) > 32 || seen[value] {
			return errors.New("saved query tags require unique trimmed strings of 1–32 characters")
		}
		seen[value] = true
	}
	return nil
}

func validateSavedQueryMetadata(metadata json.RawMessage) error {
	var values map[string]any
	if json.Unmarshal(metadata, &values) != nil || values == nil || len(values) > 12 {
		return errors.New("saved query metadata must be an object of at most 12 string entries")
	}
	for key, item := range values {
		value, ok := item.(string)
		if !ok || !validSavedQueryMetadataEntry(key, value) {
			return errors.New("saved query metadata requires trimmed keys up to 64 characters and string values up to 256 characters, without reserved keys")
		}
	}
	return nil
}

func savedQueryParameterTypes(fields map[string]json.RawMessage) (map[string]string, error) {
	types := map[string]string{}
	parameters, ok := fields["parameters"]
	if !ok {
		return types, nil
	}
	var items []json.RawMessage
	if json.Unmarshal(parameters, &items) != nil || items == nil || len(items) > 20 {
		return nil, errors.New("saved query parameters must be an array of at most 20 entries")
	}
	for _, item := range items {
		if err := validateSavedQueryParameter(item, types); err != nil {
			return nil, err
		}
	}
	return types, nil
}

func validateSavedQueryParameter(item json.RawMessage, types map[string]string) error {
	fields, err := requireObjectShape(item, []string{"name", "type"}, []string{"label", "defaultValue"})
	if err != nil {
		return err
	}
	var parameter SavedQueryParameter
	if json.Unmarshal(item, &parameter) != nil || !validVariableName(parameter.Name) || types[parameter.Name] != "" || stringUnits(parameter.Label) > 80 || (parameter.Type != "string" && parameter.Type != "number") {
		return errors.New("saved query parameters require unique valid names, bounded labels, and string or number types")
	}
	if value, ok := fields["defaultValue"]; ok {
		if err := validateQueryLiteral(value, parameter.Type); err != nil {
			return err
		}
	}
	types[parameter.Name] = parameter.Type
	return nil
}

func decodeSavedQuery(raw json.RawMessage, id string, query *SavedQuery) error {
	if json.Unmarshal(raw, query) != nil || query.SchemaVersion != 1 || query.ID != id || !validID.MatchString(query.ProviderID) || (query.Kind != "metrics" && query.Kind != "traces") {
		return errors.New("saved query requires schemaVersion 1, matching id, provider ID, and metrics or traces kind")
	}
	return validateSavedQueryText(query)
}

func validImageURLCharacters(value string) bool {
	for _, char := range value {
		if char <= 0x20 || char == 0x7f || char == '\\' || literalBoundary(char, "") {
			return false
		}
	}
	return true
}

func validImageURLPort(port string) bool {
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number > 65535 {
			return false
		}
	}
	return true
}

func validateQueryBindings(rawBindings json.RawMessage, tooltip bool) error {
	var bindings []json.RawMessage
	if json.Unmarshal(rawBindings, &bindings) != nil || bindings == nil || len(bindings) > 20 {
		return errors.New("saved query bindings must be an array of at most 20 entries")
	}
	seen := map[string]bool{}
	for _, rawBinding := range bindings {
		if err := validateQueryBinding(rawBinding, tooltip, seen); err != nil {
			return err
		}
	}
	return nil
}

type queryBinding struct{ Parameter, Source, Variable, Label, Field string }

func validateQueryBinding(rawBinding json.RawMessage, tooltip bool, seen map[string]bool) error {
	var binding queryBinding
	if json.Unmarshal(rawBinding, &binding) != nil || !validVariableName(binding.Parameter) || seen[binding.Parameter] {
		return errors.New("saved query bindings require unique valid parameter names")
	}
	seen[binding.Parameter] = true
	member, err := queryBindingMember(&binding, tooltip)
	if err != nil {
		return err
	}
	fields, err := requireObjectShape(rawBinding, []string{"parameter", "source", member}, nil)
	if err != nil {
		return err
	}
	if member == "value" {
		if err := validateQueryLiteral(fields[member], ""); err != nil {
			return err
		}
	}
	return nil
}

func queryBindingMember(binding *queryBinding, tooltip bool) (string, error) {
	var member string
	switch binding.Source {
	case "variable":
		member = "variable"
		if !validVariableName(binding.Variable) {
			return "", errors.New("saved query variable bindings require a valid dashboard variable name")
		}
	case "constant":
		member = "value"
	case "label":
		if !validTooltipQueryLabel(tooltip, binding.Label) {
			return "", errors.New("tooltip label bindings require a label of 1–128 characters")
		}
		member = "label"
	case "field":
		if !validTooltipQueryField(tooltip, binding.Field) {
			return "", errors.New("tooltip field bindings require value, timestamp, or series")
		}
		member = "field"
	default:
		return "", errors.New("unsupported saved query binding source")
	}
	return member, nil
}

func validateSavedQueryPresentation(fields map[string]json.RawMessage, query *SavedQuery) error {
	if _, present := fields["imageUrl"]; present && !validSavedQueryImageURL(query.ImageURL) {
		return errors.New("saved query imageUrl requires an HTTPS URL or root-relative path without credentials, up to 2048 characters")
	}
	if raw, present := fields["tags"]; present {
		if err := validateSavedQueryTags(raw); err != nil {
			return err
		}
	}
	if raw, present := fields["metadata"]; present {
		if err := validateSavedQueryMetadata(raw); err != nil {
			return err
		}
	}
	return nil
}

func validSavedQueryMetadataEntry(key, value string) bool {
	return key != "" && key == trimJS(key) && stringUnits(key) <= 64 && stringUnits(value) <= 256 && !reservedObjectKey(key)
}

func validateSavedQueryText(query *SavedQuery) error {
	if trimJS(query.Name) == "" || stringUnits(trimJS(query.Name)) > 120 || stringUnits(query.Description) > 500 || trimJS(query.Query) == "" || stringUnits(trimJS(query.Query)) > 8192 {
		return errors.New("saved query name, description, or query exceeds its bounds")
	}
	return nil
}

func validTooltipQueryLabel(tooltip bool, label string) bool {
	return tooltip && label != "" && stringUnits(label) <= 128
}
func validTooltipQueryField(tooltip bool, field string) bool {
	return tooltip && slices.Contains([]string{"value", "timestamp", "series"}, field)
}
