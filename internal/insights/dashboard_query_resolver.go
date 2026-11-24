package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
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
	DefaultValue *string                      `json:"defaultValue"`
	Options      []string                     `json:"options"`
	Source       *dashboardReadVariableSource `json:"source"`
}

// dashboardReadVariableSource reads the fields query_dashboard reports in variableDefinitions. It does not resolve
// the source: the values come from the console, so the rest of the source only describes it.
type dashboardReadVariableSource struct {
	Type       string                  `json:"type"`
	ProviderID string                  `json:"providerId"`
	Label      string                  `json:"label"`
	Selector   *string                 `json:"selector"`
	Field      string                  `json:"field"`
	QueryRef   *dashboardReadReference `json:"queryRef"`
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
		// Baseline is a time series' band. Nil leaves the series without one.
		Baseline *dashboardReadBaseline `json:"baseline"`
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

// dashboardReadBaseline is a time series' baseline: its earlier window (or rolling) and its band.
type dashboardReadBaseline struct {
	Window string `json:"window"`
	Band   string `json:"band,omitempty"`
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
	Name         string   `json:"name"`
	Label        string   `json:"label,omitempty"`
	DefaultValue *string  `json:"defaultValue,omitempty"`
	Options      []string `json:"options,omitempty"`
	// Source names a query-backed source (labelValues or savedQuery). A sourced variable reports its static
	// options as FallbackOptions instead of Options: they are shown only when the source fails, not as choices.
	// The type is a short fixed word, outside the detail budget.
	Source        string                        `json:"source,omitempty"`
	SourceSummary *DashboardQueryVariableSource `json:"sourceSummary,omitempty"`
	// FallbackOptions are a sourced variable's static options. query_dashboard does not resolve the source, so
	// these are not the variable's choices.
	FallbackOptions []string `json:"fallbackOptions,omitempty"`
	OptionsOmitted  int      `json:"optionsOmitted,omitempty"`
	DetailOmitted   bool     `json:"detailOmitted,omitempty"`
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
		variable := DashboardQueryVariable{Name: definition.Name}
		if definition.Source != nil {
			variable.Source = definition.Source.Type
			variable.SourceSummary = dashboardQuerySourceSummary(definition.Source)
		}
		detail := 0
		if definition.Label != "" {
			detail += encodedStringBytes(definition.Label)
		}
		if definition.DefaultValue != nil {
			detail += encodedStringBytes(*definition.DefaultValue)
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

// dashboardVariableWarnings names each override that is outside a variable's declared options. A variable
// without options accepts any string, and an override outside the list still applies, as it does in the UI.
// A sourced variable's options are its fallback, not its choices, so an override of a sourced variable is never
// checked against them. Only an empty or over-long override is named for it.
func dashboardVariableWarnings(definitions []dashboardReadVariable, overrides map[string]string) []string {
	var warnings []string
	for _, definition := range definitions {
		value, overridden := overrides[definition.Name]
		if !overridden {
			continue
		}
		if definition.Source != nil {
			switch {
			case value == "":
				warnings = append(warnings, definition.Name+"= is empty; query_dashboard does not resolve the variable source, so pass an explicit value")
			case stringUnits(value) > 1024:
				warnings = append(warnings, definition.Name+" is longer than 1024 characters")
			}
			continue
		}
		if len(definition.Options) == 0 || slices.Contains(definition.Options, value) {
			continue
		}
		warnings = append(warnings, fmt.Sprintf("%s=%s is not one of the declared options", definition.Name, warningValue(value)))
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

func resolveDashboardWidget(widget *dashboardReadWidget, saved map[string]dashboardSavedSnapshot, variables map[string]string, definitions []dashboardReadVariable) (Query, *DashboardQueryError) {
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
