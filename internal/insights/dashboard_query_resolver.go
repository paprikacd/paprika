package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

type dashboardReadDocument struct {
	ID              string                  `json:"id"`
	Title           string                  `json:"title"`
	TimeRange       string                  `json:"timeRange"`
	CustomTimeRange *dashboardReadTimeRange `json:"customTimeRange"`
	Variables       []dashboardReadVariable `json:"variables"`
	Widgets         []dashboardReadWidget   `json:"widgets"`
}

type dashboardReadTimeRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type dashboardReadVariable struct {
	Name         string                       `json:"name"`
	Label        string                       `json:"label"`
	Multi        bool                         `json:"multi"`
	AllowAll     bool                         `json:"allowAll"`
	DefaultValue *variablevalue.Value         `json:"defaultValue"`
	Options      []string                     `json:"options"`
	Source       *dashboardReadVariableSource `json:"source"`
}

// dashboardVariableType is the template kind a declared variable's value fills: a list for a variable with
// several values, otherwise a string.
func dashboardVariableType(definition *dashboardReadVariable) string {
	if definition.Multi {
		return "strings"
	}
	return "string"
}

// dashboardValueText is a variable value as the interpolator takes it: a []string for a list, else a string.
func dashboardValueText(value variablevalue.Value) any {
	if value.List {
		return value.Items
	}
	text, _ := value.Text()
	return text
}

// dashboardReadVariableSource reads the fields query_dashboard reports in variableDefinitions. The values are
// resolved per call and reported as sourceOptions; the rest of the source describes it.
type dashboardReadVariableSource struct {
	Type       string                  `json:"type"`
	ProviderID string                  `json:"providerId"`
	Label      string                  `json:"label"`
	Selector   *string                 `json:"selector"`
	Field      string                  `json:"field"`
	QueryRef   *dashboardReadReference `json:"queryRef"`
	Limit      *int                    `json:"limit"`
}

type dashboardReadWidget struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	PluginID   string `json:"pluginId"`
	Unit       string `json:"unit"`
	ProviderID string `json:"providerId"`
	Query      string `json:"query"`
	DataKind   string `json:"dataKind"`
	// Config is the plugin's declared config, read only for the series a band widget draws.
	Config           json.RawMessage          `json:"config"`
	QueryRef         *dashboardReadReference  `json:"queryRef"`
	AnnotationSource *dashboardReadAnnotation `json:"annotationSource"`
	Options          struct {
		Decimals          *int                     `json:"decimals"`
		StaleAfterSeconds *float64                 `json:"staleAfterSeconds"`
		Thresholds        []dashboardReadThreshold `json:"thresholds"`
		// Compare is a stat's earlier-window comparison. Nil leaves the stat without one.
		Compare *dashboardReadCompare `json:"compare"`
		// The declared scale and styling the dry-run data rules compare against.
		// Query output never reads them.
		Min           *float64        `json:"min"`
		Max           *float64        `json:"max"`
		ShowSparkline bool            `json:"showSparkline"`
		SeriesColors  json.RawMessage `json:"seriesColors"`
	} `json:"options"`
}

type dashboardReadCompare struct {
	Window string `json:"window"`
	Good   string `json:"good,omitempty"`
}

type dashboardReadThreshold struct {
	Value  float64 `json:"value"`
	Status string  `json:"status,omitempty"`
	Color  string  `json:"color,omitempty"`
	Label  string  `json:"label,omitempty"`
}

type dashboardReadAnnotation struct {
	QueryRef        dashboardReadReference `json:"queryRef"`
	TimestampColumn string                 `json:"timestampColumn"`
	EndColumn       string                 `json:"endColumn,omitempty"`
	LabelColumn     string                 `json:"labelColumn"`
	SeverityColumn  string                 `json:"severityColumn,omitempty"`
}

type dashboardReadReference struct {
	ID       string                 `json:"id"`
	Bindings []dashboardReadBinding `json:"bindings"`
}

type dashboardReadBinding struct {
	Parameter string          `json:"parameter"`
	Source    string          `json:"source"`
	Variable  string          `json:"variable"`
	Value     json.RawMessage `json:"value"`
}

// dashboardVariableValues applies each declaration to the defaults and overrides. A string given for a
// variable with several values is one item; a list given for a single-value variable is refused.
func dashboardVariableValues(definitions []dashboardReadVariable, overrides map[string]variablevalue.Value) (map[string]variablevalue.Value, error) {
	values := make(map[string]variablevalue.Value, len(definitions))
	declared := make(map[string]dashboardReadVariable, len(definitions))
	for _, definition := range definitions {
		declared[definition.Name] = definition
		if definition.DefaultValue != nil {
			value, err := definition.DefaultValue.Normalize(definition.Multi, definition.AllowAll)
			if err != nil {
				return nil, fmt.Errorf("default of dashboard variable %s: %w", definition.Name, err)
			}
			values[definition.Name] = value
		}
	}
	for name, value := range overrides {
		definition, ok := declared[name]
		if !ok || !validVariableName(name) {
			return nil, errors.New("variables must name declared dashboard variables with values that fit their declaration")
		}
		normalized, err := value.Normalize(definition.Multi, definition.AllowAll)
		if err != nil {
			return nil, fmt.Errorf("variable %s: %w", name, err)
		}
		values[name] = normalized
	}
	return values, nil
}

// dashboardVariableDetailBytes caps the encoded label, default and option text that query-dashboard reports per
// result. The count is the bytes the encoder writes, so escaped characters count in full. A variable whose label
// and default do not fit reports neither and sets detailOmitted. Options past the budget are counted in
// optionsOmitted. get_dashboard returns the full definitions, so one large variable cannot push a result over the cap.
const dashboardVariableDetailBytes = 4 << 10

// dashboardVariableWarningValueBytes bounds the override value a warning names. The warning keeps its reason
// (" is not one of the declared options") inside the text synopsis's per-warning limit.
const dashboardVariableWarningValueBytes = 64

// DashboardQueryVariable is a declared dashboard variable as query-dashboard reports it. Its value for this call
// is the result's variables map, which holds the saved default unless an override replaced it.
type DashboardQueryVariable struct {
	Name  string `json:"name"`
	Label string `json:"label,omitempty"`
	// Multi and AllowAll report the declaration. A multi variable's value is a list, and an empty list is All.
	Multi        bool                 `json:"multi,omitempty"`
	AllowAll     bool                 `json:"allowAll,omitempty"`
	DefaultValue *variablevalue.Value `json:"defaultValue,omitempty"`
	Options      []string             `json:"options,omitempty"`
	// Source names a query-backed source (labelValues or savedQuery). A sourced variable reports its static
	// options as FallbackOptions instead of Options: they are shown only when the source fails, not as choices.
	// The type is a short fixed word, outside the detail budget.
	Source        string                        `json:"source,omitempty"`
	SourceSummary *DashboardQueryVariableSource `json:"sourceSummary,omitempty"`
	// FallbackOptions are a sourced variable's static options. They are shown only when its source fails, so they
	// are not the variable's choices; SourceOptions holds those.
	FallbackOptions []string `json:"fallbackOptions,omitempty"`
	// SourceOptions is the value list the variable's source returned for this call. See DashboardVariableSourceOptions.
	SourceOptions  *DashboardVariableSourceOptions `json:"sourceOptions,omitempty"`
	OptionsOmitted int                             `json:"optionsOmitted,omitempty"`
	DetailOmitted  bool                            `json:"detailOmitted,omitempty"`
}

// DashboardVariableSourceOptions is the resolved source of one variable for this call. State is ready, empty,
// failed, needs_variable or not_run. Values is the list in the source's order, within the call's value budget;
// ValuesOmitted counts the values past that budget or dropped by the omission ladder. CurrentValue says whether
// the variable's current value is among the values: in_values, not_in_values or unknown (a truncated list
// without it). It is absent with no current value, or when the state is not ready or empty.
type DashboardVariableSourceOptions struct {
	State         string   `json:"state"`
	Values        []string `json:"values,omitempty"`
	ValuesOmitted int      `json:"valuesOmitted,omitempty"`
	Truncated     bool     `json:"truncated,omitempty"`
	CurrentValue  string   `json:"currentValue,omitempty"`
	// MissingValues names each current value of a multi-value variable that the list lacks. Set only with
	// the not_in_values state, so a truncated list never reports a value as missing.
	MissingValues []string             `json:"missingValues,omitempty"`
	NeedsVariable string               `json:"needsVariable,omitempty"`
	Error         *DashboardQueryError `json:"error,omitempty"`
}

// DashboardQueryVariableSource describes where a sourced variable's values come from, without the values. Only
// the fields that apply to the source kind are set. DependsOnVariables is true when the source reads another
// variable, through a selector placeholder or a variable binding.
type DashboardQueryVariableSource struct {
	Kind               string `json:"kind"`
	ProviderID         string `json:"providerId,omitempty"`
	SavedQueryID       string `json:"savedQueryId,omitempty"`
	Label              string `json:"label,omitempty"`
	Field              string `json:"field,omitempty"`
	DependsOnVariables bool   `json:"dependsOnVariables"`
}

// dashboardQuerySourceSummary reports a source's kind and identifiers, and whether it depends on another variable.
// The selector and bindings are read for that check only; their text is not reported.
func dashboardQuerySourceSummary(source *dashboardReadVariableSource) *DashboardQueryVariableSource {
	summary := &DashboardQueryVariableSource{Kind: source.Type}
	switch source.Type {
	case "labelValues":
		summary.ProviderID = source.ProviderID
		summary.Label = source.Label
		summary.DependsOnVariables = source.Selector != nil && strings.Contains(*source.Selector, "{{")
	case "savedQuery":
		if source.QueryRef != nil {
			summary.SavedQueryID = source.QueryRef.ID
			for _, binding := range source.QueryRef.Bindings {
				if binding.Source == "variable" {
					summary.DependsOnVariables = true
				}
			}
		}
		summary.Field = source.Field
	}
	return summary
}

// dashboardQueryVariables reports each declared variable with its label, default and static options, in
// declaration order. The label, default and options share one encoded byte budget, spent in that order.
func dashboardQueryVariables(definitions []dashboardReadVariable) []DashboardQueryVariable {
	if len(definitions) == 0 {
		return nil
	}
	out := make([]DashboardQueryVariable, 0, len(definitions))
	budget := dashboardVariableDetailBytes
	for _, definition := range definitions {
		variable := DashboardQueryVariable{Name: definition.Name, Multi: definition.Multi, AllowAll: definition.AllowAll}
		if definition.Source != nil {
			variable.Source = definition.Source.Type
			variable.SourceSummary = dashboardQuerySourceSummary(definition.Source)
		}
		detail := 0
		if definition.Label != "" {
			detail += encodedStringBytes(definition.Label)
		}
		if definition.DefaultValue != nil {
			detail += encodedValueBytes(*definition.DefaultValue)
		}
		if detail <= budget {
			budget -= detail
			variable.Label = definition.Label
			variable.DefaultValue = definition.DefaultValue
		} else {
			variable.DetailOmitted = true
		}
		for index, option := range definition.Options {
			cost := encodedStringBytes(option) + 1 // The comma that separates it from the previous option.
			if cost > budget {
				variable.OptionsOmitted = len(definition.Options) - index
				break
			}
			budget -= cost
			if definition.Source != nil {
				variable.FallbackOptions = append(variable.FallbackOptions, option)
			} else {
				variable.Options = append(variable.Options, option)
			}
		}
		out = append(out, variable)
	}
	return out
}

// encodedStringBytes is the length of s as the result encoder writes it, quotes and escapes included.
func encodedStringBytes(s string) int {
	encoded, err := json.Marshal(s)
	if err != nil {
		return len(s) * 6 // Unreachable for a string; the worst escape length keeps the budget safe.
	}
	return len(encoded)
}

// encodedValueBytes is the length of a variable value as the result encoder writes it.
func encodedValueBytes(value variablevalue.Value) int {
	encoded, err := json.Marshal(value)
	if err != nil {
		return 6 * (1 + variablevalue.MaxUnits) // Unreachable for a bounded value; the worst case keeps the budget safe.
	}
	return len(encoded)
}

// dashboardVariableWarnings names each override that is outside a variable's declared options. A variable
// without options accepts any string, and an override outside the list still applies, as it does in the UI.
// A sourced variable's options are its fallback, not its choices, so an override of a sourced variable is never
// checked against them. Only an empty or over-long override is named for it.
func dashboardVariableWarnings(definitions []dashboardReadVariable, overrides map[string]variablevalue.Value) []string {
	var warnings []string
	for _, definition := range definitions {
		value, overridden := overrides[definition.Name]
		if !overridden {
			continue
		}
		if definition.Source != nil {
			if text, single := value.Text(); single && text == "" {
				warnings = append(warnings, definition.Name+"= is empty; pass one of its source values")
			}
			continue
		}
		if len(definition.Options) == 0 {
			continue
		}
		for _, item := range value.Items {
			if !slices.Contains(definition.Options, item) {
				warnings = append(warnings, fmt.Sprintf("%s=%s is not one of the declared options", definition.Name, warningValue(item)))
			}
		}
	}
	return warnings
}

// warningValue shortens an override value to dashboardVariableWarningValueBytes, cut at a rune boundary.
func warningValue(value string) string {
	if len(value) <= dashboardVariableWarningValueBytes {
		return value
	}
	limit := dashboardVariableWarningValueBytes
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit] + "…"
}

func dashboardWidgetKind(widget *dashboardReadWidget) string {
	if widget.Type == "plugin" {
		return widget.DataKind
	}
	if widget.Type == "traces" {
		return "traces"
	}
	return "metrics"
}

func resolveDashboardWidget(widget *dashboardReadWidget, saved map[string]dashboardSavedSnapshot, variables map[string]variablevalue.Value, definitions []dashboardReadVariable) (Query, *DashboardQueryError) {
	query := Query{ProviderID: widget.ProviderID, Query: widget.Query, Kind: dashboardWidgetKind(widget)}
	if isSLOSummaryWidget(widget) {
		compiled, failure := resolveSLOSummaryQuery(widget)
		if failure != nil {
			return Query{}, failure
		}
		query.Query = compiled
	}
	if widget.QueryRef != nil {
		snapshot, ok := saved[widget.QueryRef.ID]
		if !ok {
			return Query{}, &DashboardQueryError{Code: "missing_saved_query", Message: "The referenced saved query is unavailable."}
		}
		if snapshot.Query.Kind != query.Kind {
			return Query{}, &DashboardQueryError{Code: "incompatible_saved_query", Message: "The saved query does not provide this widget's data kind."}
		}
		expression, err := resolveDashboardSavedQuery(&snapshot.Query, *widget.QueryRef, variables)
		if err != nil {
			return Query{}, &DashboardQueryError{Code: "invalid_bindings", Message: "Saved query parameters or bindings are missing or invalid."}
		}
		query.ProviderID, query.Query = snapshot.Query.ProviderID, expression
		return query, nil
	}
	types := make(map[string]string, len(definitions))
	values := make(map[string]any, len(variables))
	for _, definition := range definitions {
		types[definition.Name] = dashboardVariableType(&definition)
	}
	for name, value := range variables {
		values[name] = dashboardValueText(value)
	}
	expression, err := interpolateDashboardLiterals(query.Query, types, values)
	if err != nil {
		return Query{}, &DashboardQueryError{Code: "invalid_query", Message: "Widget query placeholders or dashboard variable values are invalid or missing."}
	}
	query.Query = expression
	return query, nil
}

// resolveSLOSummaryQuery compiles the query of an slo-summary widget from its config. The stored query text
// is editor output and is ignored at run time, so a saved query reference is refused.
func resolveSLOSummaryQuery(widget *dashboardReadWidget) (string, *DashboardQueryError) {
	if widget.QueryRef != nil {
		return "", &DashboardQueryError{Code: "invalid_query", Message: "slo-summary widgets take their query from config and cannot use a saved query."}
	}
	cfg, err := validateSLOSummaryConfig(widget.Config)
	if err != nil {
		return "", &DashboardQueryError{Code: "invalid_query", Message: "The slo-summary configuration is invalid."}
	}
	compiled, err := compileSLOQuery(&cfg)
	if err != nil {
		return "", &DashboardQueryError{Code: "invalid_query", Message: "The slo-summary query is too long after compilation."}
	}
	return compiled, nil
}

func resolveDashboardSavedQuery(saved *SavedQuery, reference dashboardReadReference, variables map[string]variablevalue.Value) (string, error) {
	parameters := queryParameters(saved)
	values := make(map[string]any, len(parameters))
	types := make(map[string]string, len(parameters))
	for _, parameter := range saved.Parameters {
		types[parameter.Name] = parameter.templateKind()
		if len(parameter.DefaultValue) > 0 {
			var value any
			if err := json.Unmarshal(parameter.DefaultValue, &value); err != nil {
				return "", fmt.Errorf("decode saved parameter default: %w", err)
			}
			values[parameter.Name] = value
		}
	}
	for _, binding := range reference.Bindings {
		parameter, exists := parameters[binding.Parameter]
		if !exists {
			return "", errors.New("unknown saved query parameter")
		}
		value, err := dashboardBindingValue(binding, variables)
		if err != nil {
			return "", err
		}
		checked, err := dashboardParameterValue(parameter.templateKind(), value)
		if err != nil {
			return "", err
		}
		values[binding.Parameter] = checked
	}
	for name, parameter := range parameters {
		value := values[name] // An absent required default fails the same typed-value validation.
		checked, err := dashboardParameterValue(parameter.templateKind(), value)
		if err != nil {
			return "", err
		}
		values[name] = checked
	}
	return interpolateDashboardLiterals(saved.Query, types, values)
}

func dashboardBindingValue(binding dashboardReadBinding, variables map[string]variablevalue.Value) (any, error) {
	switch binding.Source {
	case "constant":
		var value any
		if err := json.Unmarshal(binding.Value, &value); err != nil {
			return nil, fmt.Errorf("decode saved parameter binding: %w", err)
		}
		return value, nil
	case "variable":
		value, present := variables[binding.Variable]
		if !present {
			return nil, errors.New("missing dashboard variable")
		}
		return dashboardValueText(value), nil
	default:
		return nil, errors.New("observation bindings cannot execute without a hovered observation")
	}
}

func dashboardParameterValue(kind string, value any) (any, error) {
	if kind == "string" {
		if text, ok := value.(string); ok && stringUnits(text) <= 1024 {
			return text, nil
		}
		return nil, errors.New("saved query value must be bounded text")
	}
	if kind == "strings" {
		return dashboardListParameterValue(value)
	}
	if kind != "number" {
		return nil, errors.New("unsupported saved query parameter type")
	}
	return dashboardNumericParameterValue(value)
}

// dashboardListParameterValue checks a value for a parameter of several values. A single string is one item, so a
// single-value variable or a fixed string fills a list parameter. The list is bounded like a variable list, and an
// empty list is All, which binds as NULL in a SQL array.
func dashboardListParameterValue(value any) (any, error) {
	var items []string
	switch typed := value.(type) {
	case string:
		items = []string{typed}
	case []string:
		items = typed
	case []any:
		items = make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("saved query list values must be strings")
			}
			items = append(items, text)
		}
	default:
		return nil, errors.New("saved query value must be a list of bounded text")
	}
	if err := variablevalue.List(items).Validate(); err != nil {
		return nil, errors.New("saved query list value is out of bounds")
	}
	return items, nil
}

func dashboardNumericParameterValue(value any) (any, error) {
	if text, ok := value.(string); ok {
		if savedQueryNumericLiteral.MatchString(text) {
			number, err := strconv.ParseFloat(text, 64)
			if err == nil && finite(number) {
				return number, nil
			}
		}
	}
	if number, ok := value.(float64); ok && finite(number) {
		return number, nil
	}
	return nil, errors.New("saved query value does not match its parameter type")
}

// The validation pass enforces the same quote/comment/token boundaries as the
// browser. Expansion then consumes only the original template, never inserted
// values, so placeholder-looking service names cannot become query syntax.
func interpolateDashboardLiterals(template string, types map[string]string, values map[string]any) (string, error) {
	template = trimJS(template) // Both saved-query and widget schemas trim query text in the UI.
	if stringUnits(template) > 8192 {
		return "", errors.New("query exceeds the template limit")
	}
	if err := validateSavedQueryTemplate(template, types); err != nil {
		return "", err
	}
	var output strings.Builder
	consumed := 0 // Bytes of template already handled; remaining starts there.
	for remaining := template; remaining != ""; {
		start := strings.Index(remaining, "{{")
		if start < 0 {
			output.WriteString(remaining)
			break
		}
		end := strings.Index(remaining[start+2:], "}}") + start + 2
		name := remaining[start+2 : end]
		value, exists := values[name]
		if !exists {
			return "", errors.New("query parameter has no value")
		}
		literal, err := interpolatedLiteral(value, types[name], listContextBefore(template[:consumed+start]))
		if err != nil {
			return "", err
		}
		output.WriteString(remaining[:start])
		output.WriteString(literal)
		consumed += end + 2
		remaining = remaining[end+2:]
	}
	if stringUnits(output.String()) > 8192 {
		return "", errors.New("query exceeds the expanded limit")
	}
	return output.String(), nil
}

// interpolatedLiteral renders one placeholder. A "strings" parameter always renders as a list, so a single
// string is wrapped as a one-item list. The context comes from the template text before the placeholder.
func interpolatedLiteral(value any, kind string, context listContext) (string, error) {
	if items, ok := dashboardListItems(value); ok {
		return dashboardListLiteral(items, context)
	}
	if text, ok := value.(string); ok && kind == "strings" {
		return dashboardListLiteral([]string{text}, context)
	}
	return dashboardLiteral(value)
}

func dashboardListItems(value any) ([]string, bool) {
	switch items := value.(type) {
	case []string:
		return items, true
	case []any:
		out := make([]string, 0, len(items))
		for _, item := range items {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, text)
		}
		return out, true
	}
	return nil, false
}

// dashboardListLiteral renders a list of values for a regex, negated regex or SQL array position. Regex items
// are escaped like Go's regexp.QuoteMeta (the TypeScript interpolator escapes the same characters), joined with
// "|" and written as one string literal. All is ".+" after =~ and "null" as a SQL array element. Negated All is
// refused, because it would exclude every value. No anchors are added: the providers match the alternation as
// they match any regex.
func dashboardListLiteral(items []string, context listContext) (string, error) {
	switch context {
	case contextRegex, contextNegated:
		if len(items) == 0 {
			if context == contextNegated {
				return "", errors.New("an All value cannot follow !~; it would exclude every value")
			}
			return dashboardStringLiteral(".+"), nil
		}
		escaped := make([]string, len(items))
		for index, item := range items {
			escaped[index] = regexp.QuoteMeta(item)
		}
		return dashboardStringLiteral(strings.Join(escaped, "|")), nil
	case contextArray:
		if len(items) == 0 {
			return "null", nil
		}
		quoted := make([]string, len(items))
		for index, item := range items {
			quoted[index] = dashboardStringLiteral(item)
		}
		return "[" + strings.Join(quoted, ",") + "]", nil
	case contextNone:
		return "", errors.New("query list values need =~, !~ or a SQL parameters array")
	}
	return "", errors.New("query list values need =~, !~ or a SQL parameters array")
}

func dashboardLiteral(value any) (string, error) {
	if text, ok := value.(string); ok {
		return dashboardStringLiteral(text), nil
	}
	if number, ok := value.(float64); ok && finite(number) {
		if number == 0 {
			return "0", nil // JSON.stringify normalizes negative zero.
		}
		encoded, err := json.Marshal(number)
		return string(encoded), err
	}
	return "", errors.New("query literal must be a string or finite number")
}

// JSON.stringify does not HTML-escape strings or U+2028/U+2029. Keep identical
// literal text as the UI while escaping JSON control characters and quotes.
func dashboardStringLiteral(value string) string {
	var output strings.Builder
	output.WriteByte('"')
	for _, char := range value {
		switch char {
		case '"', '\\':
			output.WriteByte('\\')
			output.WriteRune(char)
		case '\b':
			output.WriteString(`\b`)
		case '\f':
			output.WriteString(`\f`)
		case '\n':
			output.WriteString(`\n`)
		case '\r':
			output.WriteString(`\r`)
		case '\t':
			output.WriteString(`\t`)
		default:
			if char < 0x20 {
				fmt.Fprintf(&output, `\u%04x`, char)
			} else {
				output.WriteRune(char)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}
