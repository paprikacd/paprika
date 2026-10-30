package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
)

var folderUnsafe = regexp.MustCompile(`[\x00-\x1f\x7f\\]`)
var timezoneDateTime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`)

func validateDashboardExtensions(root map[string]json.RawMessage) error {
	for _, check := range []struct {
		field    string
		validate func(json.RawMessage) error
	}{
		{"variables", validateDashboardVariables}, {"folder", validateDashboardFolder}, {"customTimeRange", validateDashboardTimeRange},
	} {
		if raw, ok := root[check.field]; ok {
			if err := check.validate(raw); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateDashboardFolder(raw json.RawMessage) error {
	var folder string
	if json.Unmarshal(raw, &folder) != nil {
		return errors.New("folder must be a string")
	}
	folder = trimJS(folder)
	if folder == "" || stringUnits(folder) > 160 || folderUnsafe.MatchString(folder) {
		return errors.New("folder must be a path of at most 160 characters")
	}
	for _, segment := range strings.Split(folder, "/") {
		if segment == "" || trimJS(segment) != segment || segment == "." || segment == ".." {
			return errors.New("folder must not contain empty, dot, or parent segments")
		}
	}
	return nil
}

func validateDashboardTimeRange(raw json.RawMessage) error {
	if _, err := requireObjectShape(raw, []string{"from", "to"}, nil); err != nil {
		return err
	}
	var bounds struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if json.Unmarshal(raw, &bounds) != nil || !timezoneDateTime.MatchString(bounds.From) || !timezoneDateTime.MatchString(bounds.To) {
		return errors.New("custom time bounds must be ISO datetimes with timezones")
	}
	start, errStart := time.Parse(time.RFC3339Nano, bounds.From)
	end, errEnd := time.Parse(time.RFC3339Nano, bounds.To)
	// Date.parse in the UI compares milliseconds, so sub-millisecond
	// differences must not make an otherwise empty custom range valid.
	duration := end.UnixMilli() - start.UnixMilli()
	if errStart != nil || errEnd != nil || start.UnixMilli() <= 0 || duration <= 0 || duration > 31*24*60*60*1000 {
		return errors.New("custom time range must increase by at most 31 days after the Unix epoch")
	}
	return nil
}

func validateWidgetExtensions(widget map[string]json.RawMessage) error {
	if raw, ok := widget["annotationSource"]; ok {
		if err := validateWidgetAnnotationSource(widget, raw); err != nil {
			return err
		}
	}
	if ref, ok := widget["queryRef"]; ok {
		if err := validateQueryReference(ref, false); err != nil {
			return err
		}
	}
	for _, check := range []struct {
		field    string
		validate func(json.RawMessage) error
	}{
		{"drilldowns", validateDrilldowns}, {"selectionBindings", validateDrilldownBindings}, {"options", validateWidgetOptions},
	} {
		if raw, ok := widget[check.field]; ok {
			if err := check.validate(raw); err != nil {
				return err
			}
		}
	}
	return validateWidgetPluginFields(widget)
}

func supportsWidgetAnnotationSource(widget map[string]json.RawMessage) bool {
	var kind string
	if err := json.Unmarshal(widget["type"], &kind); err != nil {
		return false
	}
	if kind == "timeseries" {
		return true
	}
	if kind != "plugin" {
		return false
	}
	var pluginID string
	if err := json.Unmarshal(widget["pluginId"], &pluginID); err != nil {
		return false
	}
	return pluginID == "stacked-timeseries" || pluginID == "directional-traffic"
}

func validateWidgetAnnotationSource(widget map[string]json.RawMessage, raw json.RawMessage) error {
	if !supportsWidgetAnnotationSource(widget) {
		return errors.New("event queries require a time-series or directional-traffic widget")
	}
	fields, err := requireObjectShape(raw, []string{"queryRef", "timestampColumn", "labelColumn"}, []string{"severityColumn", "endColumn"})
	if err != nil {
		return err
	}
	if err := validateQueryReference(fields["queryRef"], false); err != nil {
		return err
	}
	return validateWidgetAnnotationColumns(fields)
}

func validateWidgetAnnotationColumns(fields map[string]json.RawMessage) error {
	for _, name := range []string{"timestampColumn", "labelColumn", "severityColumn", "endColumn"} {
		value, exists := fields[name]
		if !exists {
			continue
		}
		var column string
		if json.Unmarshal(value, &column) != nil || trimJS(column) == "" || trimJS(column) != column || stringUnits(column) > 128 {
			return errors.New("event query column names must contain 1–128 characters")
		}
	}
	return nil
}

func validateWidgetPluginFields(widget map[string]json.RawMessage) error {
	var kind string
	if json.Unmarshal(widget["type"], &kind) != nil {
		return errors.New("widget type must be a string")
	}
	if kind != "plugin" {
		for _, field := range []string{"pluginId", "dataKind", "config"} {
			if _, ok := widget[field]; ok {
				return errors.New("pluginId, dataKind, and config are only valid for plugin widgets")
			}
		}
		return nil
	}
	var id, dataKind string
	if json.Unmarshal(widget["pluginId"], &id) != nil || !validID.MatchString(id) {
		return errors.New("plugin widgets require a valid pluginId")
	}
	if json.Unmarshal(widget["dataKind"], &dataKind) != nil || !slices.Contains([]string{"metrics", "traces", "records"}, dataKind) {
		return errors.New("plugin widgets require metrics, traces or records dataKind")
	}
	if raw, ok := widget["config"]; ok {
		return validatePluginConfig(raw)
	}
	return nil
}

func validateWidgetOptions(raw json.RawMessage) error {
	options, err := requireObjectShape(raw, nil, []string{"display", "xAxisLabel", "yAxisLabel", "showLegend", "showLabels", "showValues", "showTooltip", "tooltipTitle", "tooltipValueLabel", "tooltipShowUnit", "tooltipDecimals", "tooltipView", "showGrid", "showSparkline", "showStatBar", "sparklinePlacement", "statIcon", "decimals", "staleAfterSeconds", "min", "max", "lineWidth", "fillOpacity", "curve", "background", "textColor", "thresholds", "seriesColors"})
	if err != nil {
		return err
	}
	if value, ok := options["tooltipView"]; ok {
		if err := validateTooltipView(value); err != nil {
			return err
		}
	}
	for _, check := range []func(map[string]json.RawMessage) error{validateWidgetAxisLabels, validateWidgetTooltipPresentation, validateWidgetFlags, validateWidgetAppearance, validateWidgetNumbers, validateWidgetThresholds, validateWidgetSeriesColors} {
		if err := check(options); err != nil {
			return err
		}
	}
	return nil
}

func validateTooltipView(raw json.RawMessage) error {
	view, err := requireObjectShape(raw, []string{"type"}, []string{"height", "showGrid", "showAxis", "showLegend", "showSparkline", "title", "unit", "color", "decimals", "pluginId", "dataKind", "config", "source"})
	if err != nil {
		return err
	}
	if err := validateTooltipIdentity(view); err != nil {
		return err
	}
	return validateTooltipPresentation(view)
}

func validateTooltipIdentity(view map[string]json.RawMessage) error {
	var kind string
	if json.Unmarshal(view["type"], &kind) != nil {
		return errors.New("tooltip view type must be a widget type")
	}
	if !slices.Contains([]string{"timeseries", "bar", "stat", "table", "traces", "heatmap", "plugin"}, kind) {
		return errors.New("unsupported tooltip widget type")
	}
	if pluginErr := validateWidgetPluginFields(view); pluginErr != nil {
		return pluginErr
	}
	return validateTooltipSourceCompatibility(kind, view)
}

func validateTooltipSourceCompatibility(kind string, view map[string]json.RawMessage) error {
	source := "series"
	var err error
	if rawSource, ok := view["source"]; ok {
		source, err = validateTooltipSource(rawSource)
		if err != nil {
			return err
		}
	}
	var dataKind string
	if rawKind, ok := view["dataKind"]; ok {
		if json.Unmarshal(rawKind, &dataKind) != nil {
			return errors.New("tooltip dataKind must be a string")
		}
	}
	if (kind == "traces" || (kind == "plugin" && (dataKind == "traces" || dataKind == "records"))) && !slices.Contains([]string{"query", "saved", "widget"}, source) {
		return errors.New("trace tooltip widgets require a query, saved query, or widget result source")
	}
	return nil
}

func validateTooltipPresentation(view map[string]json.RawMessage) error {
	for _, check := range []func(map[string]json.RawMessage) error{
		validateTooltipHeight, validateTooltipFlags, validateTooltipText, validateTooltipColor, validateTooltipDecimals,
	} {
		if err := check(view); err != nil {
			return err
		}
	}
	return nil
}

func validateTooltipHeight(view map[string]json.RawMessage) error {
	if value, ok := view["height"]; ok {
		var height float64
		if json.Unmarshal(value, &height) != nil || !slices.Contains([]float64{120, 160, 200, 320}, height) {
			return errors.New("tooltip widget height must be 120, 160, 200, or 320")
		}
	}
	return nil
}

func validateTooltipColor(view map[string]json.RawMessage) error {
	if value, ok := view["color"]; ok {
		var color string
		if json.Unmarshal(value, &color) != nil || !validWidgetColor.MatchString(color) {
			return errors.New("tooltip color must be a six-digit hex color")
		}
	}
	return nil
}

func validateTooltipDecimals(view map[string]json.RawMessage) error {
	if value, ok := view["decimals"]; ok {
		var decimals float64
		if json.Unmarshal(value, &decimals) != nil || !validDecimalPrecision(decimals) {
			return errors.New("tooltip decimals must be an integer from 0 to 8")
		}
	}
	return nil
}

func validDecimalPrecision(n float64) bool {
	return finite(n) && validNumberRange(n, 0, 8) && math.Trunc(n) == n
}

func validNumberRange(n, minimum, maximum float64) bool {
	return n >= minimum && n <= maximum
}

func validateTooltipSource(raw json.RawMessage) (string, error) {
	var source struct {
		Type       string `json:"type"`
		ProviderID string `json:"providerId"`
		Query      string `json:"query"`
	}
	if json.Unmarshal(raw, &source) != nil {
		return "", errors.New("tooltip source must be an object")
	}
	if source.Type == "series" || source.Type == "widget" {
		_, err := requireObjectShape(raw, []string{"type"}, nil)
		return source.Type, err
	}
	if source.Type == "saved" {
		fields, err := requireObjectShape(raw, []string{"type", "ref"}, nil)
		if err != nil {
			return "", err
		}
		return "saved", validateQueryReference(fields["ref"], true)
	}
	if source.Type != "query" {
		return "", errors.New("tooltip source type must be series, widget, query, or saved")
	}
	if err := validateTooltipQuerySource(raw, source.ProviderID, source.Query); err != nil {
		return "", err
	}
	return "query", nil
}

func validateTooltipQuerySource(raw json.RawMessage, providerID, query string) error {
	fields, err := requireObjectShape(raw, []string{"type", "providerId", "query"}, []string{"bindings"})
	if err != nil {
		return err
	}
	if !validID.MatchString(providerID) || trimJS(query) == "" || stringUnits(trimJS(query)) > 8192 {
		return errors.New("tooltip query source requires a valid provider ID and query up to 8192 characters")
	}
	if rawBindings, ok := fields["bindings"]; ok {
		return validateTooltipBindings(rawBindings)
	}
	return nil
}

func validatePluginConfig(raw json.RawMessage) error {
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil || config == nil {
		return errors.New("plugin configuration must be a JSON object")
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(config) != nil || encoded.Len()-1 > 16<<10 {
		return errors.New("plugin configuration must be at most 16 KiB")
	}
	return validatePluginValue(config, 0)
}

func validatePluginValue(value any, depth int) error {
	if depth > 8 {
		return errors.New("plugin configuration nesting exceeds eight levels")
	}
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			if reservedObjectKey(key) {
				return errors.New("plugin configuration contains a reserved key")
			}
			if err := validatePluginValue(child, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range item {
			if err := validatePluginValue(child, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateWidgetAxisLabels(options map[string]json.RawMessage) error {
	for _, field := range []string{"xAxisLabel", "yAxisLabel"} {
		if value, ok := options[field]; ok {
			var text string
			if json.Unmarshal(value, &text) != nil || stringUnits(text) > 80 {
				return errors.New("axis labels must be strings of at most 80 characters")
			}
		}
	}

	return nil
}

func validateWidgetTooltipPresentation(options map[string]json.RawMessage) error {
	for field, limit := range map[string]int{"tooltipTitle": 120, "tooltipValueLabel": 80} {
		if value, ok := options[field]; ok {
			var text string
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &text) != nil || stringUnits(text) > limit {
				return fmt.Errorf("%s must be a string of at most %d characters", field, limit)
			}
		}
	}
	return nil
}

func validateWidgetFlags(options map[string]json.RawMessage) error {
	for _, field := range []string{"showLegend", "showLabels", "showValues", "showTooltip", "tooltipShowUnit", "showGrid", "showSparkline", "showStatBar"} {
		if value, ok := options[field]; ok {
			var flag bool
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &flag) != nil {
				return errors.New("legend, label, value, tooltip, grid, and sparkline settings must be boolean")
			}
		}
	}

	return nil
}

func validateWidgetAppearance(options map[string]json.RawMessage) error {
	if err := validateWidgetColors(options); err != nil {
		return err
	}
	if err := validateWidgetEnum(options, "display", []string{"line", "area"}, "display must be line or area"); err != nil {
		return err
	}
	for field, allowed := range map[string][]string{
		"sparklinePlacement": {"background", "side"},
		"statIcon":           {"arrow-down", "arrow-up", "shield", "network", "activity", "target", "pie"},
	} {
		if err := validateWidgetEnum(options, field, allowed, "invalid "+field); err != nil {
			return err
		}
	}
	return validateWidgetEnum(options, "curve", []string{"linear", "step", "monotone"}, "curve must be linear, step, or monotone")
}

func validateWidgetEnum(options map[string]json.RawMessage, field string, allowed []string, message string) error {
	value, ok := options[field]
	if !ok {
		return nil
	}
	var selected string
	if json.Unmarshal(value, &selected) != nil || !slices.Contains(allowed, selected) {
		return errors.New(message)
	}
	return nil
}

func validateWidgetColors(options map[string]json.RawMessage) error {
	for _, field := range []string{"background", "textColor"} {
		if value, ok := options[field]; ok {
			var color string
			if json.Unmarshal(value, &color) != nil || !validWidgetColor.MatchString(color) {
				return errors.New("widget colors must be six-digit hex colors")
			}
		}
	}
	return nil
}

func validateWidgetNumbers(options map[string]json.RawMessage) error {
	numbers, err := parseWidgetNumbers(options)
	if err != nil {
		return err
	}
	if err := validateWidgetStatBarBounds(options, numbers); err != nil {
		return err
	}
	return validateWidgetNumberBounds(numbers)
}

func parseWidgetNumbers(options map[string]json.RawMessage) (map[string]float64, error) {
	numbers := map[string]float64{}
	for _, field := range []string{"decimals", "tooltipDecimals", "staleAfterSeconds", "min", "max", "lineWidth", "fillOpacity"} {
		value, ok := options[field]
		if !ok {
			continue
		}
		var n float64
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, &n) != nil || !finite(n) {
			return nil, errors.New("widget numeric settings must be finite")
		}
		numbers[field] = n
	}
	return numbers, nil
}

func validateWidgetStatBarBounds(options map[string]json.RawMessage, numbers map[string]float64) error {
	raw, ok := options["showStatBar"]
	if !ok {
		return nil
	}
	var enabled bool
	if json.Unmarshal(raw, &enabled) != nil {
		return errors.New("stat bar setting must be boolean")
	}
	if !enabled {
		return nil
	}
	if _, ok := numbers["min"]; !ok {
		return errors.New("stat bar requires an explicit minimum")
	}
	if _, ok := numbers["max"]; !ok {
		return errors.New("stat bar requires an explicit maximum")
	}
	return nil
}

func validateWidgetSeriesColors(options map[string]json.RawMessage) error {
	raw, ok := options["seriesColors"]
	if !ok {
		return nil
	}
	var rules []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &rules) != nil || len(rules) > 24 {
		return errors.New("series colors must be an array of at most 24 rules")
	}
	seen := make(map[[2]string]bool, len(rules))
	for _, entry := range rules {
		key, err := validateWidgetSeriesColorRule(entry)
		if err != nil {
			return err
		}
		if seen[key] {
			return errors.New("duplicate series color label and value")
		}
		seen[key] = true
	}
	return nil
}

func validateWidgetSeriesColorRule(entry json.RawMessage) ([2]string, error) {
	if _, err := requireObjectShape(entry, []string{"label", "value", "color"}, nil); err != nil {
		return [2]string{}, err
	}
	var rule struct {
		Label string `json:"label"`
		Value string `json:"value"`
		Color string `json:"color"`
	}
	if json.Unmarshal(entry, &rule) != nil || !validPromLabel.MatchString(rule.Label) || len(rule.Label) > 100 || stringUnits(rule.Value) < 1 || stringUnits(rule.Value) > 256 || !validWidgetColor.MatchString(rule.Color) {
		return [2]string{}, errors.New("series colors require a valid metric label, nonempty value, and six-digit hex color")
	}
	return [2]string{rule.Label, rule.Value}, nil
}

func validateWidgetThresholds(options map[string]json.RawMessage) error {
	if value, ok := options["thresholds"]; ok {
		var thresholds []json.RawMessage
		if json.Unmarshal(value, &thresholds) != nil || len(thresholds) > 12 {
			return errors.New("thresholds must be an array of at most 12 entries")
		}
		previous := math.Inf(-1)
		for _, rawThreshold := range thresholds {
			value, err := validateWidgetThreshold(rawThreshold, previous)
			if err != nil {
				return err
			}
			previous = value
		}
	}
	return nil
}

func validateWidgetThreshold(raw json.RawMessage, previous float64) (float64, error) {
	if _, err := requireObjectShape(raw, []string{"value", "color"}, []string{"label"}); err != nil {
		return 0, err
	}
	var threshold struct {
		Value float64 `json:"value"`
		Color string  `json:"color"`
		Label string  `json:"label"`
	}
	if json.Unmarshal(raw, &threshold) != nil || !finite(threshold.Value) || threshold.Value <= previous || !validWidgetColor.MatchString(threshold.Color) || stringUnits(threshold.Label) > 80 {
		return 0, errors.New("thresholds require increasing finite values, hex colors, and labels up to 80 characters")
	}
	return threshold.Value, nil
}

func validateWidgetPrecisionBounds(numbers map[string]float64) error {
	if n, ok := numbers["staleAfterSeconds"]; ok && (n < 1 || n > 2678400 || math.Trunc(n) != n) {
		return errors.New("stale sample threshold must be an integer from 1 to 2678400 seconds")
	}
	if n, ok := numbers["tooltipDecimals"]; ok && !validDecimalPrecision(n) {
		return errors.New("tooltip decimals must be an integer from 0 to 8")
	}
	if n, ok := numbers["decimals"]; ok && !validDecimalPrecision(n) {
		return errors.New("decimals must be an integer from 0 to 8")
	}
	return nil
}

func validateWidgetNumberBounds(numbers map[string]float64) error {
	if err := validateWidgetPrecisionBounds(numbers); err != nil {
		return err
	}
	if n, ok := numbers["lineWidth"]; ok && !validNumberRange(n, 0.5, 8) {
		return errors.New("line width must be from 0.5 to 8")
	}
	if n, ok := numbers["fillOpacity"]; ok && !validNumberRange(n, 0, 1) {
		return errors.New("fill opacity must be from 0 to 1")
	}
	if minimum, ok := numbers["min"]; ok {
		if maximum, present := numbers["max"]; present && minimum >= maximum {
			return errors.New("maximum must exceed minimum")
		}
	}

	return nil
}

func validateTooltipFlags(view map[string]json.RawMessage) error {
	for _, field := range []string{"showGrid", "showAxis", "showLegend", "showSparkline"} {
		if value, ok := view[field]; ok {
			var flag bool
			if json.Unmarshal(value, &flag) != nil {
				return errors.New("tooltip grid, axis, legend, and sparkline settings must be boolean")
			}
		}
	}

	return nil
}

func validateTooltipText(view map[string]json.RawMessage) error {
	for field, maximum := range map[string]int{"title": 120, "unit": 24} {
		value, ok := view[field]
		if !ok {
			continue
		}
		var text string
		if json.Unmarshal(value, &text) != nil {
			return errors.New("tooltip title and unit must be bounded strings")
		}
		if field == "title" {
			text = trimJS(text)
			if text == "" {
				return errors.New("tooltip title must not be empty")
			}
		}
		if stringUnits(text) > maximum {
			return errors.New("tooltip title and unit must be bounded strings")
		}
	}
	return nil
}

func validateTooltipBindings(rawBindings json.RawMessage) error {
	var bindings []json.RawMessage
	if json.Unmarshal(rawBindings, &bindings) != nil || bindings == nil || len(bindings) > 20 {
		return errors.New("tooltip bindings must be an array of at most 20 entries")
	}
	seen := map[string]bool{}
	for _, rawBinding := range bindings {
		if err := validateTooltipBinding(rawBinding, seen); err != nil {
			return err
		}
	}
	return nil
}

func validateTooltipBinding(rawBinding json.RawMessage, seen map[string]bool) error {
	bindingFields, err := requireObjectShape(rawBinding, []string{"variable"}, []string{"label", "field"})
	if err != nil {
		return err
	}
	_, hasLabel := bindingFields["label"]
	_, hasField := bindingFields["field"]
	if hasLabel == hasField {
		return errors.New("tooltip bindings require exactly one label or observation field")
	}
	var binding struct {
		Variable string `json:"variable"`
		Label    string `json:"label"`
		Field    string `json:"field"`
	}
	if json.Unmarshal(rawBinding, &binding) != nil || !validVariableName(binding.Variable) || seen[binding.Variable] {
		return errors.New("tooltip bindings require unique valid variable names")
	}
	if hasLabel && !validTooltipLabelKey(binding.Label) {
		return errors.New("tooltip label keys must contain 1–128 characters")
	}
	if hasField && !slices.Contains([]string{"value", "timestamp", "series"}, binding.Field) {
		return errors.New("tooltip observation fields must be value, timestamp, or series")
	}
	seen[binding.Variable] = true
	return nil
}

func validTooltipLabelKey(label string) bool {
	return label != "" && stringUnits(label) <= 128
}

func reservedObjectKey(key string) bool {
	return key == "__proto__" || key == "prototype" || key == "constructor"
}
