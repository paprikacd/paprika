package insights

import (
	"fmt"
	"math"
	"strconv"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// dataRule is one check on what a dry run's queries returned. Unlike lint rules,
// data rules need executed queries, so they never run on a save. They are
// warnings: a provider can be down or a metric can be absent at any moment, and
// a warning never blocks a save.
type dataRule struct {
	ID       string
	Severity insightsv1.Severity
	// Fix tells an author what to change. It is fixed text, never query output.
	Fix   string
	check func(widgets []dataWidget) []lintHit
}

// dataWidget is one widget of a dry run with the results of its queries. Every
// field comes from the planned and executed query, so the rules and the reported
// state read one snapshot.
type dataWidget struct {
	index      int // position in the document's widgets array
	id         string
	title      string
	unit       string
	queryRef   bool // a saved query supplies the widget's query
	failure    *DashboardQueryError
	annotation *DashboardQueryError
	// signal is the widget's executed query. It is nil when the query did not run.
	signal    *DashboardSignal
	freshness *DashboardObservationFreshness
}

// transientQueryCodes are failures a retry can clear. They never produce a data
// finding; the widget reports unavailable instead.
var transientQueryCodes = map[string]bool{"rate_limited": true, "timeout": true, "canceled": true}

// isTransient reports whether a query failure is one a retry can clear, either
// by its code or by the flag a direct provider's capacity status sets.
func isTransient(failure *DashboardQueryError) bool {
	return failure.transient || transientQueryCodes[failure.Code]
}

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
		Fix:      "Correct the widget's query, saved query, bindings or variable values, then run the dry run again. A capacity or timeout error is not a dashboard fault and produces no finding.",
		check:    checkDataQueryError,
	},
	{
		ID:       "data.no-series",
		Severity: warningSeverity,
		Fix:      "Check the metric name, label matchers and variable values against the provider, and widen the time range if the metric is sparse.",
		check:    checkDataNoSeries,
	},
	{
		ID:       "data.unit-mismatch",
		Severity: warningSeverity,
		Fix:      "Set the unit to match the values, or change the query so it returns the percentage the unit names.",
		check:    checkDataUnitMismatch,
	},
	{
		ID:       "data.stale",
		Severity: warningSeverity,
		Fix:      "Check that the metric is still being written. If a longer silence is expected, raise staleAfterSeconds.",
		check:    checkDataStale,
	},
	{
		ID:       "data.series-cap",
		Severity: warningSeverity,
		Fix:      "Narrow the query with label matchers, an aggregation or a shorter range so the provider returns every series and point.",
		check:    checkDataSeriesCap,
	},
}

// percentTolerance is the margin a percent value may exceed 0-100 by before
// data.unit-mismatch fires. It absorbs rounding noise, so 100.4 is not a mismatch.
const percentTolerance = 1.0

// checkDataQueryError fires for each widget whose own query, or whose event
// query, failed with a code a retry does not clear. The pointer names the query
// member the widget reads: queryRef when a saved query supplies it, otherwise
// query, and annotationSource for the event query. A transient failure is silent.
func checkDataQueryError(widgets []dataWidget) []lintHit {
	var hits []lintHit
	for i := range widgets {
		widget := &widgets[i]
		if failure := widget.failure; failure != nil && !isTransient(failure) {
			hits = append(hits, dataHit(widget, queryPointer(widget), dataLabel(widget)+" query failed: "+queryFailureText(failure.Code)))
		}
		if annotation := widget.annotation; annotation != nil && !isTransient(annotation) {
			hits = append(hits, dataHit(widget, widgetBase(widget.index)+"/annotationSource", dataLabel(widget)+" event query failed: "+queryFailureText(annotation.Code)))
		}
	}
	return hits
}

// checkDataNoSeries fires for a metrics widget whose query ran and returned no
// series with a value in the window. Traces and records may legitimately be
// empty, so only metrics count. A partial response is not a proven absence, so
// it is left to data.series-cap.
func checkDataNoSeries(widgets []dataWidget) []lintHit {
	var hits []lintHit
	for i := range widgets {
		widget := &widgets[i]
		if signal := widget.signal; signal != nil && signal.Error == nil && signal.Kind == "metrics" && signal.State == "empty" {
			hits = append(hits, dataHit(widget, queryPointer(widget), dataLabel(widget)+" query returned no series with values in the range"))
		}
	}
	return hits
}

// checkDataUnitMismatch fires for a metrics widget with unit "%" whose returned
// values fall below 0 or above 100, beyond percentTolerance. It reads the
// per-series minimum and maximum of every series the summary keeps, and names
// the value furthest outside the range. Other units are not inferred: a ratio
// above 1 is a legitimate value for many quantities, so no unit rule guesses one.
func checkDataUnitMismatch(widgets []dataWidget) []lintHit {
	var hits []lintHit
	for i := range widgets {
		widget := &widgets[i]
		signal := widget.signal
		if widget.unit != "%" || signal == nil || signal.Error != nil || signal.Kind != "metrics" {
			continue
		}
		low, high, found := percentExtremes(signal.Series)
		if !found {
			continue
		}
		above, below := high-100, -low
		if above <= percentTolerance && below <= percentTolerance {
			continue
		}
		value := high
		if below > above {
			value = low
		}
		hits = append(hits, dataHit(widget, widgetBase(widget.index)+"/unit", fmt.Sprintf("%s has unit %q but returned a value of %s, outside 0-100", dataLabel(widget), "%", strconv.FormatFloat(value, 'g', 6, 64))))
	}
	return hits
}

// percentExtremes returns the lowest and highest valid value across the series.
// found is false when no series holds a valid value.
func percentExtremes(series []DashboardSeriesSummary) (low, high float64, found bool) {
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

// checkDataStale fires for a stat whose staleAfterSeconds is set and whose newest
// valid sample is older than that when the query range ends. The freshness state
// is computed by the query path, so this rule reports it and nothing else. The
// pointer names the staleAfterSeconds option.
func checkDataStale(widgets []dataWidget) []lintHit {
	var hits []lintHit
	for i := range widgets {
		widget := &widgets[i]
		freshness := widget.freshness
		if freshness == nil || freshness.State != "stale" || freshness.AgeSeconds == nil {
			continue
		}
		hits = append(hits, dataHit(widget, widgetBase(widget.index)+"/options/staleAfterSeconds",
			fmt.Sprintf("%s newest sample is %s s old, past its staleAfterSeconds of %d", dataLabel(widget), strconv.FormatFloat(math.Round(*freshness.AgeSeconds), 'f', 0, 64), freshness.ThresholdSeconds)))
	}
	return hits
}

// checkDataSeriesCap fires for each widget whose query ran and whose provider
// truncated the response, by a row or series cap or an incomplete search, so its
// values may be missing data. It reads only the provider's own flag. The summary's
// series limit is an output bound of the dry run and is not a finding.
func checkDataSeriesCap(widgets []dataWidget) []lintHit {
	var hits []lintHit
	for i := range widgets {
		widget := &widgets[i]
		if signal := widget.signal; signal != nil && signal.Error == nil && signal.ProviderTruncated {
			hits = append(hits, dataHit(widget, queryPointer(widget), dataLabel(widget)+" query result was truncated by the provider, so its values may be incomplete"))
		}
	}
	return hits
}

// dataStateOf reports what a widget's query returned, for the per-widget state
// the report carries. A failed or partial query is never reported as ok, and a
// widget whose query did not run is not_run.
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
	switch signal.State {
	case "partial":
		return insightsv1.DataState_DATA_STATE_PARTIAL
	case "empty":
		return insightsv1.DataState_DATA_STATE_EMPTY
	}
	if widget.freshness != nil && widget.freshness.State == "stale" {
		return insightsv1.DataState_DATA_STATE_STALE
	}
	return insightsv1.DataState_DATA_STATE_OK
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

func dataFinding(rule dataRule, hit lintHit) *insightsv1.CheckFinding {
	return &insightsv1.CheckFinding{
		RuleId:   rule.ID,
		Severity: rule.Severity,
		Source:   insightsv1.Source_SOURCE_DATA,
		WidgetId: boundedWidgetID(hit.widgetID),
		Pointer:  boundPointer(hit.pointer),
		Message:  truncateRunes(hit.message, maxFindingMessageRunes),
		Fix:      rule.Fix,
	}
}

// dataHit builds a hit for widget, located at pointer.
func dataHit(widget *dataWidget, pointer, message string) lintHit {
	return lintHit{pointer: pointer, widgetID: widget.id, message: message}
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

// boundedWidgetID returns a widget id that passes the id check, or the empty
// string. A finding never carries an id the document could not have stored.
func boundedWidgetID(id string) string {
	if validID.MatchString(id) {
		return id
	}
	return ""
}
