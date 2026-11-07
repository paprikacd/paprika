package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
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
	Name         string  `json:"name"`
	DefaultValue *string `json:"defaultValue"`
}

type dashboardReadWidget struct {
	ID               string                   `json:"id"`
	Title            string                   `json:"title"`
	Type             string                   `json:"type"`
	PluginID         string                   `json:"pluginId"`
	Unit             string                   `json:"unit"`
	ProviderID       string                   `json:"providerId"`
	Query            string                   `json:"query"`
	DataKind         string                   `json:"dataKind"`
	QueryRef         *dashboardReadReference  `json:"queryRef"`
	AnnotationSource *dashboardReadAnnotation `json:"annotationSource"`
	Options          struct {
		Decimals          *int                     `json:"decimals"`
		StaleAfterSeconds *float64                 `json:"staleAfterSeconds"`
		Thresholds        []dashboardReadThreshold `json:"thresholds"`
	} `json:"options"`
}

type dashboardReadThreshold struct {
	Value float64 `json:"value"`
	Color string  `json:"color"`
	Label string  `json:"label"`
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

func dashboardVariableValues(definitions []dashboardReadVariable, overrides map[string]string) (map[string]string, error) {
	values := make(map[string]string, len(definitions))
	known := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		known[definition.Name] = true
		if definition.DefaultValue != nil {
			values[definition.Name] = *definition.DefaultValue
		}
	}
	for name, value := range overrides {
		if !known[name] || !validVariableName(name) || stringUnits(value) > 1024 {
			return nil, errors.New("variables must name declared dashboard variables with string values up to 1024 characters")
		}
		values[name] = value
	}
	return values, nil
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

func resolveDashboardWidget(widget *dashboardReadWidget, saved map[string]dashboardSavedSnapshot, variables map[string]string, definitions []dashboardReadVariable) (Query, *DashboardQueryError) {
	query := Query{ProviderID: widget.ProviderID, Query: widget.Query, Kind: dashboardWidgetKind(widget)}
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
		types[definition.Name] = "string"
	}
	for name, value := range variables {
		values[name] = value
	}
	expression, err := interpolateDashboardLiterals(query.Query, types, values)
	if err != nil {
		return Query{}, &DashboardQueryError{Code: "invalid_query", Message: "Widget query placeholders or dashboard variable values are invalid or missing."}
	}
	query.Query = expression
	return query, nil
}

func resolveDashboardSavedQuery(saved *SavedQuery, reference dashboardReadReference, variables map[string]string) (string, error) {
	parameters := queryParameters(saved)
	values := make(map[string]any, len(parameters))
	types := make(map[string]string, len(parameters))
	for _, parameter := range saved.Parameters {
		types[parameter.Name] = parameter.Type
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
		checked, err := dashboardParameterValue(parameter.Type, value)
		if err != nil {
			return "", err
		}
		values[binding.Parameter] = checked
	}
	for name, parameter := range parameters {
		value := values[name] // An absent required default fails the same typed-value validation.
		checked, err := dashboardParameterValue(parameter.Type, value)
		if err != nil {
			return "", err
		}
		values[name] = checked
	}
	return interpolateDashboardLiterals(saved.Query, types, values)
}

func dashboardBindingValue(binding dashboardReadBinding, variables map[string]string) (any, error) {
	switch binding.Source {
	case "constant":
		var value any
		if err := json.Unmarshal(binding.Value, &value); err != nil {
			return nil, fmt.Errorf("decode saved parameter binding: %w", err)
		}
		return value, nil
	case "variable":
		text, present := variables[binding.Variable]
		if !present {
			return nil, errors.New("missing dashboard variable")
		}
		return text, nil
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
	if kind != "number" {
		return nil, errors.New("unsupported saved query parameter type")
	}
	return dashboardNumericParameterValue(value)
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
		literal, err := dashboardLiteral(value)
		if err != nil {
			return "", err
		}
		output.WriteString(remaining[:start])
		output.WriteString(literal)
		remaining = remaining[end+2:]
	}
	if stringUnits(output.String()) > 8192 {
		return "", errors.New("query exceeds the expanded limit")
	}
	return output.String(), nil
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
