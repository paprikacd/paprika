package insights

// The field lists the Go validators check each object against. They mirror the published dashboard schema
// (docs/design/insights/dashboard.schema.json), and contract_parity_test.go requires each list to equal that
// schema's properties and required keys at the matching node. A change here is a change to the document contract, so
// change the Zod model and regenerate the schema first. Each list keeps the order the validator always used.

// widgetRequiredFields and widgetOptionalFields are a dashboard widget's members.
var (
	widgetRequiredFields = []string{"id", "title", "type", "providerId", "query", "unit", "layout"}
	widgetOptionalFields = []string{"description", "color", "options", "pluginId", "dataKind", "config", "drilldowns", "queryRef", "selectionBindings", "annotationSource"}
)

// layoutFields are a widget's grid position, all required.
var layoutFields = []string{"x", "y", "w", "h"}

// optionFields are a widget's display options. They have no required member.
var optionFields = []string{"display", "xAxisLabel", "yAxisLabel", "showLegend", "showLabels", "showValues", "showTooltip", "tooltipTitle", "tooltipValueLabel", "tooltipShowUnit", "tooltipDecimals", "tooltipPlacement", "tooltipOffset", "tooltipMaxWidth", "tooltipMaxHeight", "tooltipView", "showGrid", "showSparkline", "showStatBar", "sparklinePlacement", "statIcon", "decimals", "staleAfterSeconds", "compare", "baseline", "showEvents", "min", "max", "lineWidth", "fillOpacity", "curve", "background", "textColor", "thresholds", "seriesColors", "seriesColorMode", "gridX", "timeAxis", "axisUnit", "referenceLines", "showZeroLine", "plotInsetLeft", "plotInsetRight"}

// tooltipView fields: type is required and the rest are optional.
var (
	tooltipViewRequiredFields = []string{"type"}
	tooltipViewOptionalFields = []string{"height", "showGrid", "showAxis", "showLegend", "showSparkline", "title", "unit", "color", "decimals", "pluginId", "dataKind", "config", "source"}
)

// referenceLine, seriesRule and threshold fields. Each names its required value and its optional members.
var (
	referenceLineRequiredFields = []string{"value"}
	referenceLineOptionalFields = []string{"label", "color"}
	seriesRuleRequiredFields    = []string{"label", "value"}
	seriesRuleOptionalFields    = []string{"color", "role"}
	thresholdRequiredFields     = []string{"value"}
	thresholdOptionalFields     = []string{"status", "color", "label"}
)

// annotationSource fields: the query and its timestamp and label columns are required.
var (
	annotationSourceRequiredFields = []string{"queryRef", "timestampColumn", "labelColumn"}
	annotationSourceOptionalFields = []string{"severityColumn", "endColumn"}
)
