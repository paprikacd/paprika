package insights

import (
	"fmt"
	"math"
	"regexp"
	"strconv"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// dataRule is one check on what a dry run's queries returned. Data rules need
// executed queries, so they never run on a save and no data finding blocks one.
// Summary says what the rule reads and where it applies; it sits in the rule
// catalogue beside the lint rules. Severity is the rule's default, and a hit may
// lower it.
type dataRule struct {
	ID       string
	Severity insightsv1.Severity
	Summary  string
	// Fix tells an author what to change. It is fixed text, never query output.
	Fix   string
	check func(widgets []dataWidget) []dataHit
}

// dataHit is one place a data rule fires. When severity is set it replaces the
// rule's severity for this hit, so one rule can be a warning for one query and
// info for another.
type dataHit struct {
	lintHit
	severity insightsv1.Severity
}

// dataWidget is one widget of a dry run with the results of its queries. Every
// field comes from the planned and executed query and the document, so the rules
// and the reported state read one snapshot.
type dataWidget struct {
	index      int // position in the document's widgets array
	id         string
	title      string
	widgetType string
	pluginID   string
	unit       string
	queryRef   bool // a saved query supplies the widget's query
	// expression is the query text the widget reads: its own, or its saved query's.
	expression string
	options    dataOptions
	failure    *DashboardQueryError
	// annotation is the failure of the widget's event query, if it has one.
	annotation *DashboardQueryError
	// signal is the widget's executed query. It is nil when the query did not run.
	signal    *DashboardSignal
	freshness *DashboardSample
}

// dataOptions are the author's declared options the data rules compare with.
type dataOptions struct {
	showSparkline bool
	seriesColors  int // number of series colour rules
	min, max      *float64
	thresholds    []float64
}

// transientQueryCodes are failures a retry can clear. They never produce a data
// finding; the widget reports unavailable instead.
var transientQueryCodes = map[string]bool{"rate_limited": true, "timeout": true, "canceled": true}

// providerQueryCodes are failures whose cause is the widget's provider setting.
var providerQueryCodes = map[string]bool{"provider_not_found": true, "forbidden": true, "incompatible_provider": true}

// queryCodeText maps each query error code to fixed prose. Findings never copy
// DashboardQueryError.Message, which can echo a submitted template.
var queryCodeText = map[string]string{
	"invalid_query":                "the provider rejected the query or the query is invalid",
	"missing_saved_query":          "the referenced saved query is unavailable",
	"invalid_bindings":             "the saved query's parameters or bindings are missing or invalid",
	"incompatible_saved_query":     "the saved query does not provide this widget's data kind",
	"incompatible_provider":        "the provider does not support this widget's data kind",
	"provider_not_found":           "the query provider is not configured",
	"forbidden":                    "the caller cannot access the query provider",
	"invalid_annotation_columns":   "the event query does not return the configured columns",
	"annotation_columns_truncated": "a configured event column sits beyond the first 12 columns",
	"provider_error":               "the provider query could not be completed",
	"rate_limited":                 "query capacity is exhausted",
	"timeout":                      "the provider query exceeded its time budget",
	"canceled":                     "the dry run was canceled",
}

// dataRules is the registry for the data.* findings, in report order.
var dataRules = []dataRule{
	{
		ID:       "data.query-error",
		Severity: warningSeverity,
		Summary:  "A widget or event query the provider rejected, or could not resolve, with a code a retry does not clear. Capacity, timeout and cancellation are not findings.",
		Fix:      "Correct the widget's query, saved query, bindings, provider or variable values, then run the dry run again. A capacity or timeout error is not a dashboard fault and produces no finding.",
		check:    checkDataQueryError,
	},
	{
		ID:       "data.no-series",
		Severity: warningSeverity,
		Summary:  "A metrics query that ran and returned no series with a value. An alert or comparison-filter query is info, because an empty result can be expected.",
		Fix:      "Check the metric name, label matchers and variable values against the provider, and widen the time range if the metric is sparse.",
		check:    checkDataNoSeries,
	},
	{
		ID:       "data.unit-mismatch",
		Severity: infoSeverity,
		Summary:  "A returned value outside the declared options.min or options.max, or a percent unit whose values all lie between 0 and 1 under a declared scale of 10 or more (a ratio shown as a percent).",
		Fix:      "Correct the declared min or max, or the unit, or the query, so the values and the scale agree. Values above 100 on a percent unit are not flagged: a multi-core CPU percentage legitimately exceeds it.",
		check:    checkDataUnitMismatch,
	},
	{
		ID:       "data.stale",
		Severity: warningSeverity,
		Summary:  "The newest valid sample is older than options.staleAfterSeconds when the range ends. Applies to stat and timeseries widgets over metrics, the only types the UI marks stale (judgesStaleAfter); a stat judges its displayed primary series, a timeseries the newest sample of any series.",
		Fix:      "Check that the metric is still being written. If a longer silence is expected, raise staleAfterSeconds.",
		check:    checkDataStale,
	},
	{
		ID:       "data.series-cap",
		Severity: warningSeverity,
		Summary:  "The provider truncated its response by a row or series cap or an incomplete search, so the values may miss data.",
		Fix:      "Narrow the query with label matchers, an aggregation or a shorter range so the provider returns every series and point.",
		check:    checkDataSeriesCap,
	},
	{
		ID:       "data.many-series",
		Severity: infoSeverity,
		Summary:  "A metrics query returned more than eight series and the widget sets no options.seriesColors rules.",
		Fix:      "Aggregate the query to fewer series, or set options.seriesColors for the series that matter.",
		check:    checkDataManySeries,
	},
	{
		ID:       "data.constant-sparkline",
		Severity: infoSeverity,
		Summary:  "A stat that shows a sparkline whose primary series holds at least two valid samples, all equal, so the sparkline draws a flat line.",
		Fix:      "Remove showSparkline from the stat if the value is expected to be constant, or query a series that moves over the range.",
		check:    checkDataConstantSparkline,
	},
}

// checkDataQueryError fires for each widget whose own query, or whose event
// query, failed with a code a retry does not clear. The pointer names the query
// member the widget reads: queryRef when a saved query supplies it, otherwise
// query. A provider-setting failure points at providerId, and an event-query
// failure at annotationSource. A transient failure is silent.
func checkDataQueryError(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		if failure := widget.failure; failure != nil && !isTransient(failure) {
			pointer := queryPointer(widget)
			if providerQueryCodes[failure.Code] {
				pointer = widgetBase(widget.index) + "/providerId"
			}
			hits = append(hits, newDataHit(widget, pointer, dataLabel(widget)+" query failed: "+queryFailureText(failure.Code)))
		}
		if annotation := widget.annotation; annotation != nil && !isTransient(annotation) {
			hits = append(hits, newDataHit(widget, widgetBase(widget.index)+"/annotationSource", dataLabel(widget)+" event query failed: "+queryFailureText(annotation.Code)))
		}
	}
	return hits
}

// expectedEmptyQuery matches an alert query (the ALERTS series) or a comparison
// filter, such as "> 0". Such a query is often empty by design, so an empty
// result is only informational. A label matcher with a quoted value does not match.
var expectedEmptyQuery = regexp.MustCompile(`\bALERTS(_FOR_STATE)?\b|(<|>|==|!=)=?\s*-?\d`)

// checkDataNoSeries fires for a metrics widget whose query ran and returned no
// series with a value in the window. Traces and records may legitimately be
// empty, so only metrics count. A partial response is not a proven absence, so
// it is left to data.series-cap. An alert or comparison-filter query is info.
func checkDataNoSeries(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		signal := widget.signal
		if signal == nil || signal.Error != nil || signal.Kind != "metrics" || signal.State != "empty" {
			continue
		}
		hit := newDataHit(widget, queryPointer(widget), dataLabel(widget)+" query returned no series with values in the range")
		if expectedEmptyQuery.MatchString(widget.expression) {
			hit.severity = infoSeverity
			hit.message = dataLabel(widget) + " query returned no series with values in the range; an alert or comparison filter can legitimately be empty"
		}
		hits = append(hits, hit)
	}
	return hits
}

// checkDataUnitMismatch fires for a metrics widget whose values contradict its own
// declared scale. Two cases, one hit per widget, the first that applies:
//
//   - a value below options.min or above options.max, when either is declared;
//   - a percent unit whose values all lie between 0 and 1, while the declared max
//     or a threshold reaches 10 or more. That is a ratio displayed as a percent.
//
// Nothing else is flagged. A percent above 100 with no declared max is a
// legitimate multi-core CPU reading, and a negative value is a legitimate change,
// so neither is compared with a fixed 0-100 range.
func checkDataUnitMismatch(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		signal := widget.signal
		if signal == nil || signal.Error != nil || signal.Kind != "metrics" {
			continue
		}
		low, high, found := seriesExtremes(signal.Series)
		if !found {
			continue
		}
		if hit, ok := declaredRangeHit(widget, low, high); ok {
			hits = append(hits, hit)
		} else if hit, ok := ratioAsPercentHit(widget, low, high); ok {
			hits = append(hits, hit)
		}
	}
	return hits
}

// declaredRangeHit reports a returned value outside the widget's declared min or max.
func declaredRangeHit(widget *dataWidget, low, high float64) (dataHit, bool) {
	if lower := widget.options.min; lower != nil && low < *lower {
		return newDataHit(widget, widgetBase(widget.index)+"/options/min", fmt.Sprintf("%s returned %s, below its declared options.min of %s", dataLabel(widget), formatDataNumber(low), formatDataNumber(*lower))), true
	}
	if upper := widget.options.max; upper != nil && high > *upper {
		return newDataHit(widget, widgetBase(widget.index)+"/options/max", fmt.Sprintf("%s returned %s, above its declared options.max of %s", dataLabel(widget), formatDataNumber(high), formatDataNumber(*upper))), true
	}
	return dataHit{}, false
}

// ratioAsPercentHit reports a percent-unit widget whose every value lies in [0, 1]
// and whose declared scale reaches 10 or more. The scale is the largest of the
// declared max and the thresholds. A series that is all zeros is not evidence.
func ratioAsPercentHit(widget *dataWidget, low, high float64) (dataHit, bool) {
	if widget.unit != "%" || low < 0 || high > 1 || high <= 0 {
		return dataHit{}, false
	}
	scale := 0.0
	if widget.options.max != nil {
		scale = *widget.options.max
	}
	for _, threshold := range widget.options.thresholds {
		scale = math.Max(scale, threshold)
	}
	if scale < 10 {
		return dataHit{}, false
	}
	return newDataHit(widget, widgetBase(widget.index)+"/unit", fmt.Sprintf(`%s has unit "%%" but every returned value lies between 0 and 1 (highest %s) while its declared scale reaches %s; the values may be a ratio shown as a percent`, dataLabel(widget), formatDataNumber(high), formatDataNumber(scale))), true
}

// seriesExtremes returns the lowest and highest valid value across the summarised
// series. found is false when no series holds a valid value.
func seriesExtremes(series []DashboardSeriesSummary) (low, high float64, found bool) {
	low, high = math.Inf(1), math.Inf(-1)
	for i := range series {
		if series[i].Min != nil {
			low = math.Min(low, *series[i].Min)
			found = true
		}
		if series[i].Max != nil {
			high = math.Max(high, *series[i].Max)
			found = true
		}
	}
	return low, high, found
}

// checkDataStale fires for a widget whose freshness is stale: its newest valid
// sample is older than options.staleAfterSeconds when the range ends. Only the types
// judgesStaleAfter names carry a stale freshness, so this rule covers stat and timeseries.
func checkDataStale(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		freshness := widget.freshness
		// Only an explicit staleAfterSeconds is the option the data.stale message names; a
		// cadence-derived limit is the UI's own stale tail and is not a declared option.
		if freshness == nil || freshness.State != "stale" || freshness.AgeSeconds == nil || freshness.Basis != sampleBasisStaleAfter || freshness.StaleAfterSeconds == nil {
			continue
		}
		hits = append(hits, newDataHit(widget, widgetBase(widget.index)+"/options/staleAfterSeconds",
			fmt.Sprintf("%s newest sample is %s s old, past its staleAfterSeconds of %d", dataLabel(widget), strconv.FormatFloat(math.Round(*freshness.AgeSeconds), 'f', 0, 64), int(*freshness.StaleAfterSeconds))))
	}
	return hits
}

// checkDataSeriesCap fires for each widget whose query ran and whose provider
// truncated the response, by a row or series cap or an incomplete search, so its
// values may be missing data. It reads only the provider's own flag. The summary's
// series limit is an output bound of the dry run and is not a finding.
func checkDataSeriesCap(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		if signal := widget.signal; signal != nil && signal.Error == nil && signal.ProviderTruncated {
			hits = append(hits, newDataHit(widget, queryPointer(widget), dataLabel(widget)+" query result was truncated by the provider, so its values may be incomplete"))
		}
	}
	return hits
}

// checkDataManySeries fires for a metrics widget that returned more than eight
// series and sets no series colour rules, so its series have no authored colours.
func checkDataManySeries(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		signal := widget.signal
		if signal == nil || signal.Error != nil || signal.Kind != "metrics" || signal.SeriesReturned == nil || *signal.SeriesReturned <= 8 || widget.options.seriesColors > 0 {
			continue
		}
		hits = append(hits, newDataHit(widget, queryPointer(widget), fmt.Sprintf("%s returned %d series and sets no options.seriesColors rules", dataLabel(widget), *signal.SeriesReturned)))
	}
	return hits
}

// checkDataConstantSparkline fires for a stat that shows a sparkline when its
// primary series holds at least two valid samples and every one of them is equal.
func checkDataConstantSparkline(widgets []dataWidget) []dataHit {
	var hits []dataHit
	for i := range widgets {
		widget := &widgets[i]
		if widget.widgetType != "stat" || !widget.options.showSparkline {
			continue
		}
		summary := primarySummary(widget.signal)
		if summary == nil || summary.Valid < 2 || summary.Min == nil || summary.Max == nil || *summary.Min != *summary.Max {
			continue
		}
		hits = append(hits, newDataHit(widget, widgetBase(widget.index)+"/options/showSparkline", fmt.Sprintf("%s sparkline is constant: all %d valid samples equal %s", dataLabel(widget), summary.Valid, formatDataNumber(*summary.Min))))
	}
	return hits
}

// primarySummary returns the summary of a successful metrics query's primary
// series, or nil when there is no such series.
func primarySummary(signal *DashboardSignal) *DashboardSeriesSummary {
	if signal == nil || signal.Error != nil || signal.Kind != "metrics" || signal.PrimarySeries == nil {
		return nil
	}
	return summaryByIndex(signal.Series, *signal.PrimarySeries)
}

// summaryByIndex returns the summary of the series with the given original index.
func summaryByIndex(series []DashboardSeriesSummary, index int) *DashboardSeriesSummary {
	for i := range series {
		if series[i].Index == index {
			return &series[i]
		}
	}
	return nil
}

// dataStateOf reports what a widget's query returned, for the per-widget state the
// report carries. A failed or partial query is never reported as ok, and a widget
// whose query did not run is not_run. A failed event query makes the widget partial.
func dataStateOf(widget *dataWidget) insightsv1.DataState {
	if failure := widget.failure; failure != nil {
		if isTransient(failure) {
			return insightsv1.DataState_DATA_STATE_UNAVAILABLE
		}
		return insightsv1.DataState_DATA_STATE_ERROR
	}
	signal := widget.signal
	if signal == nil {
		return insightsv1.DataState_DATA_STATE_NOT_RUN
	}
	if signal.State == "partial" || widget.annotation != nil {
		return insightsv1.DataState_DATA_STATE_PARTIAL
	}
	if signal.State == "empty" {
		return insightsv1.DataState_DATA_STATE_EMPTY
	}
	if widget.freshness != nil && widget.freshness.State == "stale" {
		return insightsv1.DataState_DATA_STATE_STALE
	}
	return insightsv1.DataState_DATA_STATE_OK
}

// isTransient reports whether a query failure is one a retry can clear, either
// by its code or by the flag a direct provider's capacity status sets.
func isTransient(failure *DashboardQueryError) bool {
	return failure.transient || transientQueryCodes[failure.Code]
}

// dataFindings runs every data rule over the executed widgets. Rules run in
// registry order and hits in document order, so one dry run always reports the
// same list.
func dataFindings(widgets []dataWidget) []*insightsv1.CheckFinding {
	var findings []*insightsv1.CheckFinding
	for _, rule := range dataRules {
		for _, hit := range rule.check(widgets) {
			findings = append(findings, dataFinding(rule, hit))
		}
	}
	return findings
}

func dataFinding(rule dataRule, hit dataHit) *insightsv1.CheckFinding {
	severity := rule.Severity
	if hit.severity != insightsv1.Severity_SEVERITY_UNSPECIFIED {
		severity = hit.severity
	}
	return &insightsv1.CheckFinding{
		RuleId:   rule.ID,
		Severity: severity,
		Source:   insightsv1.Source_SOURCE_DATA,
		WidgetId: boundedWidgetID(hit.widgetID),
		Pointer:  boundPointer(hit.pointer),
		Message:  truncateRunes(hit.message, maxFindingMessageRunes),
		Fix:      rule.Fix,
	}
}

// newDataHit builds a hit for widget, located at pointer, at the rule's severity.
func newDataHit(widget *dataWidget, pointer, message string) dataHit {
	return dataHit{lintHit: lintHit{pointer: pointer, widgetID: widget.id, message: message}}
}

// dataLabel names a widget for a finding message, as lint messages do.
func dataLabel(widget *dataWidget) string {
	return widgetLabel(&lintWidget{id: widget.id, title: widget.title})
}

// queryPointer is the member a widget's query is read from.
func queryPointer(widget *dataWidget) string {
	if widget.queryRef {
		return widgetBase(widget.index) + "/queryRef"
	}
	return widgetBase(widget.index) + "/query"
}

func queryFailureText(code string) string {
	if text, known := queryCodeText[code]; known {
		return text + " (" + code + ")"
	}
	return "the query could not be completed"
}

// formatDataNumber writes a value for a message: 3 significant figures, no
// exponent for the magnitudes a dashboard shows.
func formatDataNumber(value float64) string {
	return strconv.FormatFloat(value, 'g', 3, 64)
}

// boundedWidgetID returns a widget id that passes the id check, or the empty
// string. A finding never carries an id the document could not have stored.
func boundedWidgetID(id string) string {
	if validID.MatchString(id) {
		return id
	}
	return ""
}

// checkRuleCatalogEntry is one registered check in the catalogue that lists the
// lint and data rules together. Lint and data checks keep their own inputs and
// their own source, so the catalogue describes them without merging them.
type checkRuleCatalogEntry struct {
	ID       string
	Source   insightsv1.Source
	Severity insightsv1.Severity
	Summary  string
}

// checkRuleCatalog returns every registered rule, lint then data, each in its
// registry order. The findings keep the source each rule reports under.
func checkRuleCatalog() []checkRuleCatalogEntry {
	entries := make([]checkRuleCatalogEntry, 0, len(lintRules)+len(dataRules))
	for _, rule := range lintRules {
		entries = append(entries, checkRuleCatalogEntry{ID: rule.ID, Source: insightsv1.Source_SOURCE_LINT, Severity: rule.Severity, Summary: rule.Summary})
	}
	for _, rule := range dataRules {
		entries = append(entries, checkRuleCatalogEntry{ID: rule.ID, Source: insightsv1.Source_SOURCE_DATA, Severity: rule.Severity, Summary: rule.Summary})
	}
	return entries
}
