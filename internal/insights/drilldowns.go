package insights

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
)

var variableIdentifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

func validVariableName(name string) bool {
	return variableIdentifier.MatchString(name) && name != "__proto__" && name != "prototype" && name != "constructor"
}

func validateDashboardVariables(raw json.RawMessage) error {
	var variables []json.RawMessage
	if json.Unmarshal(raw, &variables) != nil || variables == nil || len(variables) > 20 {
		return errors.New("dashboard variables must be an array of at most 20 entries")
	}
	seen := map[string]bool{}
	for i, item := range variables {
		if err := validateDashboardVariable(item, seen); err != nil {
			return in(strconv.Itoa(i), err)
		}
	}
	return nil
}

func validateDrilldowns(raw json.RawMessage) error {
	var drilldowns []json.RawMessage
	if json.Unmarshal(raw, &drilldowns) != nil || drilldowns == nil || len(drilldowns) > 8 {
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
	fields, err := requireObjectShape(item, []string{"name"}, []string{"label", "defaultValue", "options"})
	if err != nil {
		return err
	}
	var variable struct {
		Name         string `json:"name"`
		Label        string `json:"label"`
		DefaultValue string `json:"defaultValue"`
	}
	const message = "dashboard variables require unique identifier names up to 64 characters, labels up to 80, and string values up to 1024"
	if json.Unmarshal(item, &variable) != nil || !validVariableName(variable.Name) || seen[variable.Name] {
		return fieldErr("name", message)
	}
	if stringUnits(variable.Label) > 80 {
		return fieldErr("label", message)
	}
	if stringUnits(variable.DefaultValue) > 1024 {
		return fieldErr("defaultValue", message)
	}
	seen[variable.Name] = true
	if options, ok := fields["options"]; ok {
		return in("options", validateDashboardVariableOptions(options))
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
	if json.Unmarshal(item, &link) != nil || !validID.MatchString(link.ID) || seen[link.ID] {
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
	if json.Unmarshal(item, &binding) != nil || !validVariableName(binding.Variable) || seen[binding.Variable] {
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
