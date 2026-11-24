package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

var variableIdentifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

func validVariableName(name string) bool {
	return variableIdentifier.MatchString(name) && name != "__proto__" && name != "prototype" && name != "constructor"
}

func validateDashboardVariables(raw json.RawMessage) error {
	// Only the first 21 entries are read: one more than the limit is enough to refuse the array.
	variables, total, err := boundedArray(raw, 21)
	if err != nil || variables == nil || total > 20 {
		return errors.New("dashboard variables must be an array of at most 20 entries")
	}
	seen := map[string]bool{}
	for i, item := range variables {
		if err := validateDashboardVariable(item, seen); err != nil {
			return in(strconv.Itoa(i), err)
		}
	}
	return validateDashboardVariableSources(variables, seen)
}

// validateDashboardVariableSources checks every variable source once all names are
// declared, so a dependency can point at any variable and a cycle is caught as a whole.
func validateDashboardVariableSources(variables []json.RawMessage, declared map[string]bool) error {
	dependencies := map[string][]string{}
	names := make([]string, 0, len(variables))
	positions := map[string]int{}
	for i, item := range variables {
		var variable struct {
			Name   string          `json:"name"`
			Source json.RawMessage `json:"source"`
		}
		if err := decodeMember(item, &variable, "dashboard variables require a valid shape"); err != nil {
			return in(strconv.Itoa(i), err)
		}
		names = append(names, variable.Name)
		positions[variable.Name] = i
		if variable.Source == nil {
			continue
		}
		refs, err := validateDashboardVariableSource(variable.Source)
		if err != nil {
			return in(strconv.Itoa(i), in("source", err))
		}
		for _, ref := range refs {
			if !declared[ref] {
				return in(strconv.Itoa(i), in("source", fmt.Errorf("source depends on undeclared variable %q", ref)))
			}
		}
		dependencies[variable.Name] = refs
	}
	if cycle := findVariableCycle(dependencies, names); cycle != "" {
		return in(strconv.Itoa(positions[cycle]), in("source", errors.New(variableSourceCycleMessage)))
	}
	return nil
}

const variableSourceCycleMessage = "dashboard variable sources must not depend on themselves or form a cycle"

// findVariableCycle returns a variable on a dependency cycle, or "" when there is none.
// Each variable has at most 20 dependencies in a valid document, so depth-first search is cheap.
func findVariableCycle(dependencies map[string][]string, order []string) string {
	const (
		unvisited = iota
		visiting
		done
	)
	state := map[string]int{}
	var visit func(name string) string
	visit = func(name string) string {
		switch state[name] {
		case visiting:
			return name
		case done:
			return ""
		}
		state[name] = visiting
		for _, next := range dependencies[name] {
			if found := visit(next); found != "" {
				return found
			}
		}
		state[name] = done
		return ""
	}
	for _, name := range order {
		if found := visit(name); found != "" {
			return found
		}
	}
	return ""
}

// variableSourceSelectorPlaceholder finds a {{name}} placeholder in a selector template.
var variableSourceSelectorPlaceholder = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

// variableSourceSelectorShape accepts a bare metric name or a name with one brace-enclosed
// matcher list, after placeholders are replaced by a quoted literal.
var variableSourceSelectorShape = regexp.MustCompile(`^(?:[A-Za-z_:][A-Za-z0-9_:]*)?\{[^{}]*\}$|^[A-Za-z_:][A-Za-z0-9_:]*$`)

// selectorTemplateMessage is shared with the browser check in schema.ts; keep them identical.
const selectorTemplateMessage = "selector placeholders must be complete unquoted literals outside comments"

// validateDashboardVariableSource checks one source and returns the declared variables it reads.
func validateDashboardVariableSource(raw json.RawMessage) ([]string, error) {
	var header struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &header) != nil {
		return nil, errors.New("dashboard variable sources must be JSON objects")
	}
	switch header.Type {
	case "labelValues":
		return validateLabelValuesSource(raw)
	case "savedQuery":
		return validateSavedQueryVariableSource(raw)
	}
	return nil, fieldErr("type", "dashboard variable source type must be labelValues or savedQuery")
}

func validateVariableSourceLimit(limit *int) error {
	if limit != nil && (*limit < 1 || *limit > 100) {
		return fieldErr("limit", "dashboard variable source limits must be integers from 1 to 100")
	}
	return nil
}

func validateLabelValuesSource(raw json.RawMessage) ([]string, error) {
	fields, err := requireObjectShape(raw, []string{"type", "providerId", "label"}, []string{"selector", "limit"})
	if err != nil {
		return nil, err
	}
	var source struct {
		ProviderID string  `json:"providerId"`
		Label      string  `json:"label"`
		Selector   *string `json:"selector"`
		Limit      *int    `json:"limit"`
	}
	const message = "label value sources require a provider ID, a label of 1–128 characters, and an optional selector of up to 1024 characters"
	if err := decodeMember(raw, &source, message); err != nil {
		return nil, err
	}
	if !validID.MatchString(source.ProviderID) {
		return nil, fieldErr("providerId", message)
	}
	if source.Label == "" || stringUnits(source.Label) > 128 {
		return nil, fieldErr("label", message)
	}
	if err := validateVariableSourceLimit(source.Limit); err != nil {
		return nil, err
	}
	if _, ok := fields["selector"]; !ok {
		return nil, nil
	}
	return validateVariableSourceSelector(source.Selector, message)
}

// validateVariableSourceSelector checks a selector template and returns its placeholder variables.
func validateVariableSourceSelector(selector *string, message string) ([]string, error) {
	if selector == nil || *selector == "" || stringUnits(*selector) > 1024 {
		return nil, fieldErr("selector", message)
	}
	var refs []string
	types := map[string]string{}
	for _, match := range variableSourceSelectorPlaceholder.FindAllStringSubmatch(*selector, -1) {
		if !validVariableName(match[1]) {
			return nil, fieldErr("selector", "selector placeholders must name a declared variable")
		}
		refs = append(refs, match[1])
		types[match[1]] = "string"
	}
	shape := variableSourceSelectorPlaceholder.ReplaceAllString(*selector, `"x"`)
	if !variableSourceSelectorShape.MatchString(shape) {
		return nil, fieldErr("selector", "selector must be a metric name or one brace-enclosed matcher list")
	}
	// Placeholders expand as whole quoted literals, exactly as query templates do, so a
	// quoted placeholder or one inside a comment is refused here and not at view time.
	if validateSavedQueryTemplate(*selector, types) != nil {
		return nil, fieldErr("selector", selectorTemplateMessage)
	}
	return refs, nil
}

func validateSavedQueryVariableSource(raw json.RawMessage) ([]string, error) {
	fields, err := requireObjectShape(raw, []string{"type", "queryRef", "field"}, []string{"limit"})
	if err != nil {
		return nil, err
	}
	var source struct {
		Field string `json:"field"`
		Limit *int   `json:"limit"`
	}
	const message = "saved query variable sources require a field of 1–128 characters and an optional limit"
	if err := decodeMember(raw, &source, message); err != nil {
		return nil, err
	}
	if source.Field == "" || stringUnits(source.Field) > 128 {
		return nil, fieldErr("field", message)
	}
	if err := validateVariableSourceLimit(source.Limit); err != nil {
		return nil, err
	}
	if err := validateQueryReference(fields["queryRef"], false); err != nil {
		return nil, in("queryRef", err)
	}
	var ref struct {
		Bindings []queryBinding `json:"bindings"`
	}
	if err := json.Unmarshal(fields["queryRef"], &ref); err != nil {
		return nil, in("queryRef", errors.New("saved query references require valid bindings"))
	}
	var refs []string
	for _, binding := range ref.Bindings {
		if binding.Source == "variable" {
			refs = append(refs, binding.Variable)
		}
	}
	return refs, nil
}

func validateDrilldowns(raw json.RawMessage) error {
	// Only the first 9 entries are read: one more than the limit is enough to refuse the array.
	drilldowns, total, err := boundedArray(raw, 9)
	if err != nil || drilldowns == nil || total > 8 {
		return errors.New("widget drilldowns must be an array of at most 8 entries")
	}
	seen := map[string]bool{}
	for i, item := range drilldowns {
		if err := validateDrilldown(item, seen); err != nil {
			return in(strconv.Itoa(i), err)
		}
	}
	return nil
}

func validateDrilldownBindings(raw json.RawMessage) error {
	var bindings []json.RawMessage
	if json.Unmarshal(raw, &bindings) != nil || bindings == nil || len(bindings) > 20 {
		return errors.New("drilldown bindings must be an array of at most 20 entries")
	}
	seen := map[string]bool{}
	for i, item := range bindings {
		if err := validateDrilldownBinding(item, seen); err != nil {
			return in(strconv.Itoa(i), err)
		}
	}
	return nil
}

func validateDashboardVariable(item json.RawMessage, seen map[string]bool) error {
	fields, err := requireObjectShape(item, []string{"name"}, []string{"label", "multi", "allowAll", "defaultValue", "options", "source"})
	if err != nil {
		return err
	}
	var variable struct {
		Name     string `json:"name"`
		Label    string `json:"label"`
		Multi    bool   `json:"multi"`
		AllowAll bool   `json:"allowAll"`
	}
	const message = "dashboard variables require unique identifier names up to 64 characters, labels up to 80, and string values up to 1024"
	// A decode failure names no member: the element is the thing that is wrong.
	if err := decodeMember(item, &variable, message); err != nil {
		return err
	}
	if !validVariableName(variable.Name) || seen[variable.Name] {
		return fieldErr("name", message)
	}
	if stringUnits(variable.Label) > 80 {
		return fieldErr("label", message)
	}
	if err := validateDashboardVariableSeveral(fields, variable.Multi, variable.AllowAll); err != nil {
		return err
	}
	seen[variable.Name] = true
	if options, ok := fields["options"]; ok {
		return in("options", validateDashboardVariableOptions(options))
	}
	return nil
}

// validateDashboardVariableSeveral applies the rules for several values and All: Include All needs a multi-value
// variable, a multi-value variable needs options or a source, and its default is a list (empty means All).
func validateDashboardVariableSeveral(fields map[string]json.RawMessage, multi, allowAll bool) error {
	if allowAll && !multi {
		return fieldErr("allowAll", "Include All needs several values turned on")
	}
	_, hasOptions := fields["options"]
	_, hasSource := fields["source"]
	if multi && !hasOptions && !hasSource {
		return fieldErr("multi", "A variable with several values needs options or a source")
	}
	raw, ok := fields["defaultValue"]
	if !ok {
		return nil
	}
	if err := validateDashboardVariableDefault(raw, multi, allowAll); err != nil {
		return fieldErr("defaultValue", err.Error())
	}
	return nil
}

// validateDashboardVariableDefault applies the document rules to a default. A variable with several values takes
// a list, and an empty list is All, which needs allowAll. A single-value variable takes a string.
func validateDashboardVariableDefault(raw json.RawMessage, multi, allowAll bool) error {
	var value variablevalue.Value
	if err := json.Unmarshal(raw, &value); err != nil {
		return errors.New("a default must be a string, or a list of strings for a variable with several values")
	}
	if value.List != multi {
		if multi {
			return errors.New("use a list default for a variable with several values")
		}
		return errors.New("a single-value variable takes a text default")
	}
	if multi && len(value.Items) == 0 && !allowAll {
		return errors.New("an empty default means All; turn on Include All")
	}
	if err := value.Validate(); err != nil {
		return fmt.Errorf("default: %w", err)
	}
	return nil
}

func validateDashboardVariableOptions(options json.RawMessage) error {
	var values []json.RawMessage
	if json.Unmarshal(options, &values) != nil || len(values) < 1 || len(values) > 100 {
		return errors.New("dashboard variable options must be an array of 1–100 unique strings")
	}
	choices := map[string]bool{}
	for i, value := range values {
		var option *string
		if json.Unmarshal(value, &option) != nil || option == nil || stringUnits(*option) > 1024 || choices[*option] {
			return in(strconv.Itoa(i), errors.New("dashboard variable options require unique string values up to 1024 characters"))
		}
		choices[*option] = true
	}
	return nil
}

func validateDrilldown(item json.RawMessage, seen map[string]bool) error {
	fields, err := requireObjectShape(item, []string{"id", "title", "dashboardId"}, []string{"carryTimeRange", "bindings"})
	if err != nil {
		return err
	}
	var link struct {
		ID             string `json:"id"`
		Title          string `json:"title"`
		DashboardID    string `json:"dashboardId"`
		CarryTimeRange bool   `json:"carryTimeRange"`
	}
	const message = "drilldowns require unique IDs, local dashboard IDs, titles up to 120 characters, and optional boolean carryTimeRange"
	if err := decodeMember(item, &link, message); err != nil {
		return err
	}
	if !validID.MatchString(link.ID) || seen[link.ID] {
		return fieldErr("id", message)
	}
	if !validID.MatchString(link.DashboardID) {
		return fieldErr("dashboardId", message)
	}
	if trimJS(link.Title) == "" || stringUnits(trimJS(link.Title)) > 120 {
		return fieldErr("title", message)
	}
	seen[link.ID] = true
	if bindings, ok := fields["bindings"]; ok {
		if err := validateDrilldownBindings(bindings); err != nil {
			return in("bindings", err)
		}
	}
	return nil
}

func validateDrilldownBinding(item json.RawMessage, seen map[string]bool) error {
	fields, err := requireObjectShape(item, []string{"variable", "source"}, []string{"value"})
	if err != nil {
		return err
	}
	var binding struct {
		Variable string `json:"variable"`
		Source   string `json:"source"`
		Value    string `json:"value"`
	}
	const message = "drilldown bindings require unique variable names and string values up to 1024 characters"
	if err := decodeMember(item, &binding, message); err != nil {
		return err
	}
	if !validVariableName(binding.Variable) || seen[binding.Variable] {
		return fieldErr("variable", message)
	}
	if stringUnits(binding.Value) > 1024 {
		return fieldErr("value", message)
	}
	seen[binding.Variable] = true
	_, hasValue := fields["value"]
	return validateDrilldownBindingSource(binding.Source, binding.Value, hasValue)
}

// validateDrilldownBindingSource reports a source that does not fit its value.
// A label source keeps its key in value, so a bad key points there; a constant
// without a value names no member, because the value is what is missing.
func validateDrilldownBindingSource(source, value string, hasValue bool) error {
	switch source {
	case "label":
		if !hasValue || value == "" || stringUnits(value) > 128 {
			return fieldErr("value", "label bindings require a label key of 1–128 characters")
		}
	case "constant":
		if !hasValue {
			return errors.New("constant bindings require a value")
		}
	case "value", "series":
		if hasValue {
			return fieldErr("value", "value and series bindings do not take a configured value")
		}
	default:
		return fieldErr("source", "drilldown binding source must be label, value, series, or constant")
	}
	return nil
}
