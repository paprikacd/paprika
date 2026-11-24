package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

const dashboardQueryResponseBytes = 130 << 10
const dashboardQueryTextBytes = 8 << 10

type dashboardQueryAdmissionKey struct{}

// WithDashboardQueryAdmission records whether the HTTP admission layer acquired
// a dashboard orchestration slot. The marker is server-owned, never derived from
// a client header. Direct/in-process callers without HTTP admission are allowed.
func WithDashboardQueryAdmission(ctx context.Context, admitted bool) context.Context {
	return context.WithValue(ctx, dashboardQueryAdmissionKey{}, admitted)
}

// dashboardAdmissionLimitText names the envelope limit the HTTP layer applies to
// orchestration requests (cmd's maxObserveDashboardEnvelopeBytes). A refusal names
// it, so the caller knows what to change.
const dashboardAdmissionLimitText = "36 KiB"

// requireDashboardQueryAdmission refuses nested data work that the HTTP layer did
// not admit as orchestration. The refusal is invalid_argument, never a capacity
// code: retrying the same request cannot succeed, so agents must change the
// request. A request marked as not admitted is one whose tool name the layer
// could not read within its first 36 KiB.
func requireDashboardQueryAdmission(ctx context.Context) error {
	if admitted, marked := ctx.Value(dashboardQueryAdmissionKey{}).(bool); marked && !admitted {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("dashboard query requires bounded orchestration admission; name the tool within the first "+dashboardAdmissionLimitText+" of the MCP request and keep the envelope within that limit"))
	}
	return nil
}

const dashboardQueryInputSchema = `{"type":"object","additionalProperties":false,"required":["id"],"properties":{
"id":` + insightsIDSchema + `,
"variables":{"type":"object","maxProperties":20,"additionalProperties":{"anyOf":[{"type":"string","maxLength":1024},{"type":"array","maxItems":100,"uniqueItems":true,"items":{"type":"string","maxLength":1024}}]},"description":"Overrides declared dashboard variables for this read only; saved defaults are unchanged. A list picks several values for a variable declared with multi; an empty list is All. A string for a multi variable is one value."},
"widget_ids":{"type":"array","minItems":1,"maxItems":48,"uniqueItems":true,"items":` + insightsIDSchema + `,"description":"Optional widget subset; omitted queries all widgets."},
"start":{"type":"string","format":"date-time","description":"RFC3339 inclusive start; provide end too. Otherwise use the saved dashboard time range."},
"end":{"type":"string","format":"date-time","description":"RFC3339 end; provide start too. At most 31 days after start."},
"history_points":{"anyOf":[{"const":0},{"type":"integer","minimum":2,"maximum":32}],"default":0,"description":"Optional bounded chronological history per returned series with explicit missing values. Zero (default) omits history; 2–32 limits points. Exact first/last values and extrema remain in the summary."},
"max_series":{"type":"integer","minimum":1,"maximum":8,"default":3,"description":"Maximum series summaries per signal; omitted series are reported explicitly."},
"max_traces":{"type":"integer","minimum":1,"maximum":10,"default":3,"description":"Maximum trace examples per signal. Counts describe the bounded provider sample, never total traffic."}
}}`

// The response is a versioned machine contract, independent of visual layout.
// Numeric observations retain provider precision; display decimals are metadata.
const dashboardQueryOutputSchema = `{"type":"object","required":["schemaVersion","dashboard","observedAt","range","variables","widgets","savedQueries","signals","queryCount","state"],"properties":{
"schemaVersion":{"const":1},
"attention":{"type":"object","additionalProperties":false,"required":["basis","widgets","checked","critical","warning","failed","stale"],"description":"Dashboard-level count of widgets that need attention. Each widget is counted once, under its most severe reason: critical or warning (an author-declared band, or a time series with such a breach in the window), failed (its query or planning failed) or stale. Checked counts widgets whose query returned usable data. This is a count of declared statuses, failures and staleness, not a health verdict; state is data availability.","properties":{"basis":{"type":"string"},"widgets":{"type":"integer","minimum":0},"checked":{"type":"integer","minimum":0},"critical":{"type":"integer","minimum":0},"warning":{"type":"integer","minimum":0},"failed":{"type":"integer","minimum":0},"stale":{"type":"integer","minimum":0}}},
"omitted":{"type":"array","description":"Optional detail dropped, in this order, so the structured result fits the 130 KiB cap. Each name is omitted everywhere it applies: variableOptions removes every sourced variable's listed values, and their count moves into sourceOptions.valuesOmitted (state, currentValue, truncated and error stay); breachIntervals removes the listed breach intervals and their series names (window summaries, latest levels and intervalsOmitted counts stay); rankingRows removes each ranked record table's previewed rows, columns and statuses (its counts, hidden rows and reason stay); breaches removes each widget's breach object, with its summary and latest level; bandSeries removes each multi-series band's whole bandSeries object, so the drawn and omitted counts and the series that set the band are absent (the band threshold stays); sample removes the time-series freshness object; it removes each stale sample on a widget whose attention already reads stale, and each sample whose state is not stale, entirely, so a widget then has no sample; and it removes the basis, staleAfterSeconds, lastTimestamp and ageSeconds of every other stale sample (its state stays). A stat's first-contract freshness is never removed. sloBurn removes the burn windows of each slo-summary group; its state, reasons, counts and budget stay. Attention counts are computed before any omission and are never changed. Narrow the query with widget_ids to get omitted detail back. Absent when nothing was dropped.","items":{"enum":["variableOptions","breachIntervals","rankingRows","breaches","bandSeries","sample","sloBurn"]},"uniqueItems":true},
"dashboard":{"type":"object","required":["id","title","etag"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"etag":{"type":"string"}}},
"observedAt":{"type":"string","format":"date-time"},
"range":{"type":"object","required":["start","end","stepSeconds"],"properties":{"start":{"type":"string","format":"date-time"},"end":{"type":"string","format":"date-time"},"stepSeconds":{"type":"number","description":"The shared step policy for the whole range, given the coarsest provider minimum among its metrics queries. A metrics signal carries its own stepSeconds only when it differs from this one."}}},
"variables":{"type":"object","additionalProperties":{"anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]},"description":"The effective value of each variable for this call: the saved default, or the override. A list holds the values of a multi variable; an empty list is All."},
"variableDefinitions":{"type":"array","description":"Each declared dashboard variable, in declaration order, with its label, saved default and static options, so an agent can choose values without get_dashboard. Label, default and options share a 4 KiB encoded budget per result: optionsOmitted counts options past it, and detailOmitted marks a label and default left out of it. get_dashboard returns the full definitions. Absent when the dashboard declares no variables.","items":{"type":"object","required":["name"],"additionalProperties":false,"properties":{"name":{"type":"string"},"label":{"type":"string"},"multi":{"type":"boolean","description":"The variable takes several values; its value is then a list."},"allowAll":{"type":"boolean","description":"An empty list means All."},"defaultValue":{"anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]},"options":{"type":"array","items":{"type":"string"}},"source":{"type":"string","enum":["labelValues","savedQuery"],"description":"Query-backed source of the variable. Its sourceOptions lists the values the source returned for this call; fallbackOptions are only the fallback shown when the source fails."},"sourceSummary":{"type":"object","required":["kind","dependsOnVariables"],"additionalProperties":false,"description":"Where a sourced variable's values come from, without the values. dependsOnVariables is true when the source reads another variable.","properties":{"kind":{"enum":["labelValues","savedQuery"]},"providerId":{"type":"string"},"savedQueryId":{"type":"string"},"label":{"type":"string","description":"The label a labelValues source reads."},"field":{"type":"string","description":"The column or series label a savedQuery source reads."},"dependsOnVariables":{"type":"boolean"}}},"fallbackOptions":{"type":"array","items":{"type":"string"},"description":"A sourced variable's static options. They are the fallback shown when the source fails, not the choices; sourceOptions holds the choices."},"sourceOptions":{"type":"object","required":["state"],"additionalProperties":false,"description":"The values a sourced variable's source returned for this call, for the current values and range, in the source's order. A current value outside them is kept and marked, never replaced. Values share a 16 KiB encoded budget per result: valuesOmitted counts values past it or dropped by the variableOptions step.","properties":{"state":{"enum":["ready","empty","failed","needs_variable","not_run"]},"values":{"type":"array","items":{"type":"string"}},"valuesOmitted":{"type":"integer","minimum":0},"truncated":{"type":"boolean","description":"The source's limit, the 1024-character value limit or the provider cut the list."},"currentValue":{"enum":["in_values","not_in_values","unknown"],"description":"Whether the current value is among the values. unknown means a truncated list does not show it. Absent when the state is not ready or empty, or there is no current value."},"needsVariable":{"type":"string","description":"The parent variable a dependent source waits for."},"error":{"$ref":"#/$defs/error"}}},"optionsOmitted":{"type":"integer","minimum":0},"detailOmitted":{"type":"boolean","description":"The label and default were left out of the 4 KiB budget; see variableDefinitions."}}}},
"warnings":{"type":"array","description":"Inputs the call accepted but that may be wrong. An override outside a variable's declared options is accepted and applied, and is named here. Absent when there are none; a warning never fails the call.","items":{"type":"string"}},
"widgets":{"type":"array","items":{"type":"object","required":["id","title","type","unit"],"allOf":[{"if":{"required":["ranking"]},"else":{"properties":{"threshold":{"if":{"properties":{"state":{"const":"matched"}},"required":["state"]},"then":{"required":["boundary"]}}}}}],"properties":{"id":{"type":"string"},"title":{"type":"string"},"type":{"type":"string"},"pluginId":{"type":"string","description":"Registered visualization ID when type is plugin; configuration remains in the saved dashboard document."},"dataKind":{"enum":["metrics","records","traces"],"description":"Normalized input kind for a plugin visualization."},"savedQueryId":{"type":"string","description":"Saved query referenced by this widget, including failed resolution; see savedQueries for its captured ETag when available."},"annotationSavedQueryId":{"type":"string","description":"Saved query referenced by the widget annotation source, including failed resolution."},"unit":{"type":"string"},"decimals":{"type":"integer"},"signalId":{"type":"string"},"error":{"$ref":"#/$defs/error"},"attention":{"enum":["critical","warning","failed","stale"],"description":"The most severe reason this widget needs attention. Absent when none applies. Counts appear in the top-level attention summary. A time series counts by breaches in its window; see breaches.latestLevel for the newest sample."},"comparison":{"type":"object","required":["state","window","offsetSeconds","changeUnit"],"description":"A stat's change against its earlier window. The change is point to point: the displayed sample against the latest valid sample of the same series in that window. It is information, not status. state not_run means the earlier window was not queried within the budget and is never no change; unavailable and error give a reason or error instead of a change.","properties":{"state":{"enum":["ok","partial","unavailable","error","not_run"]},"window":{"enum":["previous","1d","7d"]},"offsetSeconds":{"type":"number","description":"How far back the earlier window sits, in seconds."},"current":{"$ref":"#/$defs/sample","description":"The displayed sample."},"baseline":{"$ref":"#/$defs/sample","description":"The latest valid sample of the same series in the earlier window."},"delta":{"type":"number","description":"Displayed minus baseline, in changeUnit."},"percent":{"type":"number","description":"Delta divided by the absolute baseline, in percent. Absent when the baseline is zero."},"changeUnit":{"type":"string","description":"pp for a percentage widget, otherwise the widget unit."},"direction":{"enum":["up","down","flat"],"description":"flat means the change rounds to nothing at the widget's display, so it has no direction; delta and percent stay exact."},"assessment":{"enum":["better","worse","unchanged"],"description":"Set only when the stat declares which direction is better. unchanged accompanies flat."},"reason":{"enum":["no_previous_range","no_current_sample","no_prior_sample","ambiguous_series","time_budget"]},"error":{"$ref":"#/$defs/error"}}},"sample":{"type":"object","additionalProperties":false,"required":["state"],"description":"Age of the widget's latest valid returned sample relative to the selected range end, and the limit that judges it. Every metric widget reports it, unless the result cap removed it (see omitted). The age is the primary series' latest sample for a stat and the newest sample across series for a time series. A limit applies to a stat or time series with staleAfterSeconds, and to a time series without one by the UI's cadence fallback (twice the longest cadence among the series that reported last); a truncated time-series result is not judged. Unknown means no usable sample; no_threshold means the age is reported with no limit. This is not underlying scrape or ingestion health.","properties":{"state":{"enum":["fresh","stale","unknown","no_threshold"]},"basis":{"enum":["staleAfterSeconds","cadence"],"description":"What set the limit; absent when none applies."},"staleAfterSeconds":{"type":"number","exclusiveMinimum":0,"description":"The limit in effect, in seconds. Fractional for a cadence limit."},"lastTimestamp":{"type":"number","description":"Unix milliseconds"},"ageSeconds":{"type":"number"}}},"breaches":{"type":"object","additionalProperties":false,"required":["seriesEvaluated","intervals","summary"],"description":"Time-series stretches inside the author's warning or critical bands within the returned window, from each of up to 12 series evaluated with its own observed cadence. Intervals run from the first breaching sample to the last, extended toward the next observed contiguous sample by at most one cadence. A zero durationMs is a single breaching sample. The most recent intervals per level are listed, within a dashboard-wide budget; the summary counts every interval, merged across series. latestLevel names the level of the newest sample. Not a health verdict.","properties":{"seriesEvaluated":{"type":"integer","minimum":0,"maximum":12},"seriesOmitted":{"type":"integer","minimum":0,"description":"Returned series beyond the twelve evaluated."},"latestLevel":{"enum":["critical","warning"],"description":"The band of the newest sample. Absent when that sample is not in a warning or critical band."},"intervals":{"type":"array","maxItems":24,"items":{"type":"object","additionalProperties":false,"required":["series","level","start","end","durationMs"],"properties":{"series":{"type":"integer","minimum":0},"name":{"type":"string","description":"Bounded label of the series."},"level":{"enum":["warning","critical"]},"start":{"type":"number","description":"Unix milliseconds"},"end":{"type":"number","description":"Unix milliseconds"},"durationMs":{"type":"number","minimum":0}}}},"intervalsOmitted":{"type":"integer","minimum":0,"description":"Intervals older than those listed, cut by the dashboard budget, or omitted under the result cap (see the top-level omitted)."},"summary":{"type":"array","maxItems":2,"items":{"type":"object","additionalProperties":false,"required":["level","intervals","samples","durationMs"],"properties":{"level":{"enum":["critical","warning"]},"intervals":{"type":"integer","minimum":0,"description":"Merged spans with positive duration, across series."},"samples":{"type":"integer","minimum":0,"description":"Single breaching samples outside those spans."},"durationMs":{"type":"number","minimum":0,"description":"Merged breaching time."}}}}}},"freshness":{"type":"object","description":"Freshness object, kept for clients that read it. A stat's is the first contract's: it is present wherever an explicit staleAfterSeconds judges the stat, and the result cap keeps it. A time series with an explicit staleAfterSeconds also has one, added after the first contract, unless its result is truncated or the result cap removed it (see omitted). Its state is fresh, stale or unknown. Use sample for every metric widget.","required":["thresholdSeconds","state"],"properties":{"thresholdSeconds":{"type":"integer","description":"The widget's staleAfterSeconds."},"state":{"enum":["fresh","stale","unknown"]},"lastTimestamp":{"type":"number","description":"Unix milliseconds"},"ageSeconds":{"type":"number"}}},"threshold":{"type":"object","additionalProperties":false,"description":"A configured visual band that names a status, not an alert or service-health verdict. Stat bands use the last valid displayed sample. Gauges, status grids and status histories, and heatmaps evaluate the series the visualization draws, each on its latest recorded sample (a missing one is unknown and sets no band), and report the most severe matched band; bandSeries names the series that set it. A matched band names a status (ok, info, warning, critical or unknown), a six-digit hex color override, or both. The first band also applies below its boundary. A ranked record table's band names its worst row's status and has no boundary, because rows are banded by mapping or by a column's own thresholds. A color override, when present, replaces the status mark for that band. A missing latest observation is reported separately on the signal.","required":["state"],"properties":{"state":{"enum":["matched","unknown"]},"boundary":{"type":"number"},"status":{"enum":["ok","info","warning","critical","unknown"]},"color":{"type":"string"},"label":{"type":"string"}},"oneOf":[{"properties":{"state":{"const":"matched"}},"anyOf":[{"required":["status"]},{"required":["color"]}]},{"properties":{"state":{"const":"unknown"}},"not":{"anyOf":[{"required":["boundary"]},{"required":["status"]},{"required":["color"]},{"required":["label"]}]}}]},"ranking":{"type":"object","additionalProperties":false,"required":["basis","evaluated"],"description":"A record table that declares rank: its loaded rows ranked worst first by the author's declared statuses, then the rank value column in its order, then source position. Counts cover every loaded row; rows are the first ranked rows the limit keeps, at most 10 with 12 columns and strings capped at 160 characters, and are omitted under the result cap (see omitted). hidden counts rows the limit cut, including critical and warning rows. The worst declared row sets the widget's threshold, so the widget counts in attention. partial with reason means the ranking covers loaded rows only, or the rank could not be drawn. Not a health verdict.","properties":{"basis":{"type":"string"},"status":{"type":"string"},"value":{"type":"string"},"order":{"enum":["descending","ascending"]},"evaluated":{"type":"integer","minimum":0,"description":"Loaded rows ranked."},"limit":{"type":"integer","minimum":1,"maximum":100},"counts":{"type":"object","additionalProperties":{"type":"integer","minimum":0},"description":"Loaded rows per level: critical, warning, unknown, info, ok, undeclared (a colour-only band or unmapped value) and missing (no value)."},"hidden":{"type":"object","additionalProperties":false,"required":["rows","critical","warning"],"properties":{"rows":{"type":"integer","minimum":0},"critical":{"type":"integer","minimum":0},"warning":{"type":"integer","minimum":0}}},"columns":{"type":"array","maxItems":12,"items":{"$ref":"#/$defs/recordColumn"}},"rows":{"type":"array","maxItems":10,"items":{"type":"array","maxItems":12,"items":{"type":["string","number","boolean","null"]}}},"statuses":{"type":"array","maxItems":10,"items":{"enum":["critical","warning","unknown","info","ok","undeclared","missing"]}},"partial":{"type":"boolean"},"reason":{"type":"string"}}},"bandSeries":{"type":"object","additionalProperties":false,"required":["evaluated","omitted"],"description":"For a multi-series band: how many of the series the visualization draws were evaluated, how many returned series it does not draw, and which series set the band. Absent when the result cap removed it (see omitted); the band's threshold remains.","properties":{"evaluated":{"type":"integer","minimum":0},"omitted":{"type":"integer","minimum":0},"series":{"type":"integer","minimum":0,"description":"The series that set a matched band."},"name":{"type":"string","description":"Bounded label of that series."}}},"slo":{"type":"object","additionalProperties":false,"required":["basis","objective","period","evaluatedAt","state","reasons","counts","groups","groupsOmitted"],"description":"An slo-summary widget's authored objective evaluated over the returned window. A reading of the author's objective, not a health verdict: breaching counts as critical and at_risk as warning in attention. unknown means no evaluated group: no traffic, no data, or an incomplete truncated result. partial means no evaluated group is worse than meeting, but some group is unknown or a truncated grouped result may have hidden groups. Groups are sorted worst first and listed up to max_series; groupsOmitted counts the rest. burn lists each SRE-workbook window pair, its factor scaled to the period, and whether it fires; sloBurn in omitted removes burn only. A negative budgetRemaining means the error budget is overspent.","properties":{"basis":{"type":"string"},"objective":{"type":"number"},"period":{"enum":["1d","7d","28d","30d"]},"evaluatedAt":{"type":"string","format":"date-time","description":"The range end the window was evaluated at."},"state":{"enum":["meeting","at_risk","breaching","unknown","partial"],"description":"The worst evaluated group. partial means no evaluated group is worse than meeting, but some group is unknown or a truncated grouped result may have hidden groups, so the objective is not proven met."},"reasons":{"type":"array","items":{"enum":["budget_exhausted","fast_burn","slow_burn","no_traffic","no_data","incomplete"]}},"counts":{"type":"object","required":["meeting","at_risk","breaching","unknown"],"properties":{"meeting":{"type":"integer","minimum":0},"at_risk":{"type":"integer","minimum":0},"breaching":{"type":"integer","minimum":0},"unknown":{"type":"integer","minimum":0}}},"groups":{"type":"array","items":{"type":"object","required":["labels","state","reasons"],"properties":{"labels":{"type":"object","additionalProperties":{"type":"string"}},"state":{"enum":["meeting","at_risk","breaching","unknown"]},"reasons":{"type":"array","items":{"enum":["budget_exhausted","fast_burn","slow_burn","no_traffic","no_data","incomplete"]}},"availability":{"type":["number","null"],"description":"Percent of requests that were not bad over the period."},"errorRatio":{"type":["number","null"]},"budgetRemaining":{"type":["number","null"],"description":"Percent of the error budget left; negative when overspent."},"total":{"type":["number","null"]},"bad":{"type":["number","null"]},"allowed":{"type":["number","null"]},"burn":{"type":"array","items":{"type":"object","required":["long","short","factor","severity","longBurn","shortBurn","firing"],"properties":{"long":{"type":"string"},"short":{"type":"string"},"factor":{"type":"number"},"severity":{"enum":["critical","warning"]},"longBurn":{"type":["number","null"]},"shortBurn":{"type":["number","null"]},"firing":{"type":"boolean"}}}}}}},"groupsOmitted":{"type":"integer","minimum":0}}},"annotationSignalId":{"type":"string"},"annotationError":{"$ref":"#/$defs/error"},"annotationColumns":{"type":"object","required":["timestamp","label"],"properties":{"timestamp":{"type":"string"},"end":{"type":"string","description":"Optional end-time column for interval annotations."},"label":{"type":"string"},"severity":{"type":"string"}}}}}},
"savedQueries":{"type":"array","items":{"type":"object","required":["id","etag"],"properties":{"id":{"type":"string"},"etag":{"type":"string"}}}},
"signals":{"type":"array","items":{"type":"object","required":["id","state"],"properties":{
"id":{"type":"string"},"kind":{"enum":["metrics","records","traces"],"description":"Normalized query kind, including empty and failed results."},"providerId":{"type":"string","description":"Resolved provider ID when the caller is authorized to resolve the provider; omitted when its lookup fails."},"state":{"enum":["ok","partial","empty","error"],"description":"Data availability, not health. A source-limited response without usable observations is partial rather than definitively empty; populated limited responses remain ok and disclose providerTruncated."},"error":{"$ref":"#/$defs/error"},"latencyMs":{"type":"integer","minimum":0,"description":"Time of this signal in whole milliseconds, from asking for Insights admission to the gateway answer. Includes the admission wait and gateway queueing, not only provider time. Absent when the query was not admitted."},"stepSeconds":{"type":"number","minimum":0,"description":"Query step in seconds the metrics signal ran at, after its provider minimum step. Present only when it differs from range.stepSeconds. Absent for records and traces."},"primarySeries":{"type":"integer"},
"truncated":{"type":"boolean","description":"Some data was omitted from this bounded signal or its compact summary; check providerTruncated and the specific preview flags to distinguish source limits from presentation limits."},"providerTruncated":{"type":"boolean","description":"The provider response hit a source limit or was otherwise partial. State can still be ok when a bounded query succeeded; do not treat returned counts as source-wide totals."},"providerTruncation":{"enum":["row_limit","partial","provider_warning"],"description":"Why the provider response is truncated, when providerTruncated is true. row_limit: the source's row cap was reached and the first rows are shown. partial: the source reported an incomplete response. provider_warning: the source reported warnings."},"seriesTruncated":{"type":"boolean","description":"The compact output omitted fetched series; distinct from providerTruncated."},"seriesReturned":{"type":"integer","minimum":0,"description":"Series in the bounded provider response, not source-wide cardinality. Present for successful metric queries, including zero."},"seriesOmitted":{"type":"integer","minimum":0,"description":"Fetched series omitted from the compact summary; independent of source limits disclosed by providerTruncated."},
"series":{"type":"array","items":{"$ref":"#/$defs/series"}},"records":{"$ref":"#/$defs/records"},
"traces":{"type":"object","required":["returned","statusCounts"],"properties":{"returned":{"type":"integer"},"statusCounts":{"type":"object","additionalProperties":{"type":"integer"}},"examplesTruncated":{"type":"boolean"},"metadataTruncated":{"type":"boolean"},"examples":{"type":"array","items":{"type":"object","required":["traceId","status"],"properties":{"traceId":{"type":"string"},"service":{"type":"string"},"operation":{"type":"string"},"durationMs":{"type":"number","description":"Trace duration in milliseconds."},"startTime":{"type":"number","description":"Trace start as Unix milliseconds."},"status":{"type":"string"},"invalidFields":{"type":"boolean"}}}}}}
}}},
"queryCount":{"type":"object","required":["planned","executed","deduplicated"],"properties":{"planned":{"type":"integer"},"executed":{"type":"integer"},"deduplicated":{"type":"integer"},"comparison":{"type":"object","required":["planned","executed"],"description":"Earlier-window queries for stats that declare a comparison: distinct queries planned, and those executed. Absent when no stat declares one.","properties":{"planned":{"type":"integer"},"executed":{"type":"integer"}}},"variableOptions":{"type":"object","required":["planned","executed"],"description":"Variable source fetches: distinct fetches planned, and those executed. Absent when no variable declares a source.","properties":{"planned":{"type":"integer"},"executed":{"type":"integer"}}}}},
"state":{"enum":["ok","partial","empty"]}
},"$defs":{
"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}},
"sample":{"type":"object","required":["timestamp","value"],"properties":{"timestamp":{"type":"number","description":"Unix milliseconds"},"value":{"type":"number"}}},
"recordColumn":{"type":"object","additionalProperties":false,"required":["key","type"],"properties":{"key":{"type":"string","minLength":1,"maxLength":128},"label":{"type":"string","maxLength":256},"type":{"enum":["string","number","boolean","timestamp"]},"unit":{"type":"string","maxLength":24}}},
"records":{"type":"object","additionalProperties":false,"required":["returned","columns","rows"],"properties":{"returned":{"type":"integer","minimum":0,"maximum":1000,"description":"Rows in the fetched provider page, not a source-wide total."},"columns":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/recordColumn"}},"rows":{"type":"array","maxItems":3,"items":{"type":"array","minItems":1,"maxItems":12,"items":{"type":["string","number","boolean","null"]}},"description":"Preview tuples in column order; null remains missing and zero remains zero."},"rowsTruncated":{"type":"boolean"},"columnsOmitted":{"type":"integer","minimum":0,"maximum":52},"metadataTruncated":{"type":"boolean"}}},
"series":{"type":"object","required":["index","samples","valid","missing"],"properties":{"index":{"type":"integer"},"name":{"type":"string"},"labels":{"type":"object","additionalProperties":{"type":"string"}},"samples":{"type":"integer"},"valid":{"type":"integer"},"missing":{"type":"integer"},"invalidTimestamps":{"type":"integer"},"duplicateObservations":{"type":"integer","minimum":1,"description":"Additional returned observations sharing a valid timestamp in this series, including missing-valued observations. Some visualizations reject duplicate timestamps and require query aggregation. Statistics include all valid samples."},"first":{"$ref":"#/$defs/sample","description":"First valid finite observation."},"last":{"$ref":"#/$defs/sample","description":"Latest valid finite observation; check tailMissing and lastAt before treating it as the latest recorded sample."},"min":{"type":"number"},"max":{"type":"number"},"mean":{"type":"number","description":"Arithmetic mean of all finite returned observations with valid timestamps, including duplicate timestamps; not time weighted or a source-wide average. Omitted when no finite observations exist."},"firstAt":{"type":"number","description":"Earliest recorded timestamp, including missing values, in Unix milliseconds."},"lastAt":{"type":"number","description":"Latest recorded timestamp, including missing values, in Unix milliseconds."},"tailMissing":{"type":"boolean","description":"The latest recorded observation has no finite value; last refers to an earlier valid observation when present."},"metadataTruncated":{"type":"boolean"},"labelsOmitted":{"type":"integer"},"historyTruncated":{"type":"boolean"},"history":{"type":"array","items":{"type":"array","minItems":2,"maxItems":2,"prefixItems":[{"type":"number","description":"Unix milliseconds"},{"type":["number","null"]}]}}}}
}}`

func insightsQueryDashboardTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{
		Name: "query_dashboard", Title: "Read dashboard signals", Scope: mcp.ScopeObserve,
		Description: "Execute a saved dashboard with its live saved queries and optional variable overrides. Returns compact, versioned machine-readable signals: exact latest values, unweighted means of returned finite samples, bounded range summaries, trace samples and record previews, plus document versions and missing/error/truncation states. Structured content carries an attention summary (author-declared warning and critical statuses, query failures and staleness, counted per widget), per-widget declared bands, time-series breach intervals within the window and freshness for metric widgets. Compact text leads with that attention summary and includes the execution range, bounded selected variables, widget and provider errors, declared bands, breach intervals and bounded per-series observations for multi-series signals, with omissions disclosed; structured content remains authoritative and may contain more detail. Sample means include duplicate timestamps and are not time weighted or source-wide. Declared bands, breaches and attention describe author-configured thresholds, not alert or service health. Record previews include at most 3 rows and 12 columns; returned counts describe the fetched page, never a source-wide total. When the encoded result would exceed 130 KiB, optional detail is dropped in the order listed in the top-level omitted field (breach intervals, per-widget breaches, band series objects, sample detail), and the text names what was dropped; attention and state are never dropped. Identical queries execute once. variableDefinitions declares each variable's label, default and options; an override outside its options is still applied and named in warnings. A stat with options.compare also returns its change against an earlier window (comparison); state not_run means the window was not queried within budget and is never no change. No layout, query expressions or raw metric sample arrays by default. State describes data availability, not service health. A sourced variable's sourceOptions lists the values its source returned for the current values and range; a current value outside them is kept and marked not_in_values, never replaced. To load a dependent variable's values, pass its parent's value. Read-only; requires paprika:observe and human Insights read permission, not authoring consent.",
		InputSchema: json.RawMessage(dashboardQueryInputSchema), OutputSchema: json.RawMessage(dashboardQueryOutputSchema),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			if err := requireDashboardQueryAdmission(ctx); err != nil {
				return nil, err
			}
			if err := validateDashboardQueryEnvelope(raw); err != nil {
				return nil, err
			}
			body, _, err := c.requestAuthorized(ctx, http.MethodPost, "query-dashboard", raw, nil, false, dashboardQueryResponseBytes)
			if err != nil {
				return nil, err
			}
			// A change that rounds to nothing reads as unchanged in the structured output and the text alike.
			body = settleDashboardComparisons(body)
			text, err := dashboardQueryText(body)
			if err != nil {
				return nil, connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid dashboard summary"))
			}
			return &sdkmcp.CallToolResult{StructuredContent: body, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: text}}}, nil
		},
	}
}

// Runtime performs full field validation; reject malformed and oversized input
// before it can enter the authenticated proxy or any provider execution.
func validateDashboardQueryEnvelope(raw json.RawMessage) error {
	if len(raw) > 32<<10 || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("dashboard query arguments must be an object of at most 32 KiB"))
	}
	var args struct {
		ID            string                         `json:"id"`
		Variables     map[string]variablevalue.Value `json:"variables,omitempty"`
		WidgetIDs     []string                       `json:"widget_ids,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
		Start         string                         `json:"start,omitempty"`
		End           string                         `json:"end,omitempty"`
		HistoryPoints *int                           `json:"history_points,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
		MaxSeries     *int                           `json:"max_series,omitempty"`     //nolint:tagliatelle // MCP arguments use snake_case.
		MaxTraces     *int                           `json:"max_traces,omitempty"`     //nolint:tagliatelle // MCP arguments use snake_case.
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil || !insightsDocumentID.MatchString(args.ID) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid dashboard query arguments"))
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("expected one dashboard query argument object"))
	}
	return nil
}

type dashboardTextSample struct {
	Timestamp float64 `json:"timestamp"`
	Value     float64 `json:"value"`
}

type dashboardTextSeries struct {
	Index                 int                  `json:"index"`
	Name                  string               `json:"name"`
	Labels                map[string]string    `json:"labels"`
	Last                  *dashboardTextSample `json:"last"`
	Mean                  *float64             `json:"mean"`
	TailMissing           bool                 `json:"tailMissing"`
	DuplicateObservations int                  `json:"duplicateObservations"`
}

type dashboardTextSignal struct {
	ID                 string                `json:"id"`
	Kind               string                `json:"kind"`
	ProviderID         string                `json:"providerId"`
	StepSeconds        *float64              `json:"stepSeconds"`
	State              string                `json:"state"`
	Error              *dashboardTextError   `json:"error"`
	PrimarySeries      *int                  `json:"primarySeries"`
	Series             []dashboardTextSeries `json:"series"`
	Records            *dashboardTextRecords `json:"records"`
	Truncated          bool                  `json:"truncated"`
	ProviderTruncated  bool                  `json:"providerTruncated"`
	ProviderTruncation string                `json:"providerTruncation"`
	SeriesTruncated    bool                  `json:"seriesTruncated"`
	SeriesReturned     *int                  `json:"seriesReturned"`
	SeriesOmitted      *int                  `json:"seriesOmitted"`
	Traces             *dashboardTextTraces  `json:"traces"`
}

type dashboardTextTraces struct {
	Returned          int            `json:"returned"`
	StatusCounts      map[string]int `json:"statusCounts"`
	ExamplesTruncated bool           `json:"examplesTruncated"`
	MetadataTruncated bool           `json:"metadataTruncated"`
	Examples          []struct {
		TraceID       string   `json:"traceId"`
		Service       string   `json:"service"`
		Operation     string   `json:"operation"`
		Status        string   `json:"status"`
		DurationMs    *float64 `json:"durationMs"`
		StartTime     *float64 `json:"startTime"`
		InvalidFields bool     `json:"invalidFields"`
	} `json:"examples"`
}

type dashboardTextError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type dashboardTextRecords struct {
	Returned          int  `json:"returned"`
	RowsTruncated     bool `json:"rowsTruncated"`
	ColumnsOmitted    int  `json:"columnsOmitted"`
	MetadataTruncated bool `json:"metadataTruncated"`
	Columns           []struct {
		Key  string `json:"key"`
		Unit string `json:"unit"`
	} `json:"columns"`
	Rows [][]json.RawMessage `json:"rows"`
}

type dashboardTextWidget struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Type     string `json:"type"`
	PluginID string `json:"pluginId"`
	Unit     string `json:"unit"`
	// Decimals is the widget's decimal places; nil means Auto (three significant figures for a value with a unit, six otherwise).
	Decimals           *int                `json:"decimals"`
	SignalID           string              `json:"signalId"`
	AnnotationSignalID string              `json:"annotationSignalId"`
	Error              *dashboardTextError `json:"error"`
	AnnotationError    *dashboardTextError `json:"annotationError"`
	Freshness          *struct {
		State            string   `json:"state"`
		ThresholdSeconds *int     `json:"thresholdSeconds"`
		AgeSeconds       *float64 `json:"ageSeconds"`
	} `json:"freshness"`
	Threshold  *dashboardTextThreshold    `json:"threshold"`
	BandSeries *dashboardTextBandSeries   `json:"bandSeries"`
	Ranking    *dashboardTextRanking      `json:"ranking"`
	Comparison *dashboardTextComparison   `json:"comparison"`
	Sample     *dashboardTextWidgetSample `json:"sample"`
	Attention  string                     `json:"attention"`
	Breaches   *dashboardTextBreaches     `json:"breaches"`
	SLO        *dashboardTextSLO          `json:"slo"`
}

// dashboardTextSLOCounts is how many groups sit in each objective state.
type dashboardTextSLOCounts struct {
	Meeting   int `json:"meeting"`
	AtRisk    int `json:"at_risk"` //nolint:tagliatelle // The state name is at_risk on the wire, as in the insights package.
	Breaching int `json:"breaching"`
	Unknown   int `json:"unknown"`
}

// dashboardTextSLO is an slo-summary widget's objective reading: its state, the counts and the listed groups.
type dashboardTextSLO struct {
	State     string                 `json:"state"`
	Objective float64                `json:"objective"`
	Period    string                 `json:"period"`
	Reasons   []string               `json:"reasons"`
	Counts    dashboardTextSLOCounts `json:"counts"`
	Groups    []struct {
		Labels          map[string]string `json:"labels"`
		State           string            `json:"state"`
		Reasons         []string          `json:"reasons"`
		Availability    *float64          `json:"availability"`
		BudgetRemaining *float64          `json:"budgetRemaining"`
	} `json:"groups"`
	GroupsOmitted int `json:"groupsOmitted"`
}

// dashboardTextRanking is a ranked record-table's ranking, as the text synopsis reads it.
type dashboardTextRanking struct {
	Status    string         `json:"status"`
	Value     string         `json:"value"`
	Evaluated int            `json:"evaluated"`
	Counts    map[string]int `json:"counts"`
	Hidden    *struct {
		Rows     int `json:"rows"`
		Critical int `json:"critical"`
		Warning  int `json:"warning"`
	} `json:"hidden"`
	Rows    [][]any `json:"rows"`
	Partial bool    `json:"partial"`
	Reason  string  `json:"reason"`
}

// dashboardTextComparison is a stat's change against its earlier window, as the text synopsis reads it.
type dashboardTextComparison struct {
	State         string   `json:"state"`
	Window        string   `json:"window"`
	OffsetSeconds float64  `json:"offsetSeconds"`
	Delta         *float64 `json:"delta"`
	Percent       *float64 `json:"percent"`
	ChangeUnit    string   `json:"changeUnit"`
	Direction     string   `json:"direction"`
	Assessment    string   `json:"assessment"`
	Reason        string   `json:"reason"`
}

// dashboardTextWidgetSample is the age of a metric widget's latest sample and the limit in effect.
type dashboardTextWidgetSample struct {
	State             string   `json:"state"`
	Basis             string   `json:"basis"`
	StaleAfterSeconds *float64 `json:"staleAfterSeconds"`
	AgeSeconds        *float64 `json:"ageSeconds"`
}

// dashboardTextBandSeries names the series a multi-series band was evaluated over.
type dashboardTextBandSeries struct {
	Evaluated int    `json:"evaluated"`
	Omitted   int    `json:"omitted"`
	Series    *int   `json:"series"`
	Name      string `json:"name"`
}

// dashboardTextThreshold is a configured visual band in the structured output. A matched band names a status, a colour
// or both, so status and color are each optional. Series is set for a multi-series band.
type dashboardTextThreshold struct {
	State    string   `json:"state"`
	Boundary *float64 `json:"boundary"`
	Status   string   `json:"status"`
	Color    string   `json:"color"`
	Label    string   `json:"label"`
}

type dashboardTextBreaches struct {
	SeriesEvaluated  int    `json:"seriesEvaluated"`
	SeriesOmitted    int    `json:"seriesOmitted"`
	IntervalsOmitted int    `json:"intervalsOmitted"`
	LatestLevel      string `json:"latestLevel"`
	Intervals        []struct {
		Series     int     `json:"series"`
		Name       string  `json:"name"`
		Level      string  `json:"level"`
		Start      float64 `json:"start"`
		End        float64 `json:"end"`
		DurationMs float64 `json:"durationMs"`
	} `json:"intervals"`
	Summary []struct {
		Level      string  `json:"level"`
		Intervals  int     `json:"intervals"`
		Samples    int     `json:"samples"`
		DurationMs float64 `json:"durationMs"`
	} `json:"summary"`
}

type dashboardTextAttention struct {
	Basis    string `json:"basis"`
	Widgets  int    `json:"widgets"`
	Checked  int    `json:"checked"`
	Critical int    `json:"critical"`
	Warning  int    `json:"warning"`
	Failed   int    `json:"failed"`
	Stale    int    `json:"stale"`
}

type dashboardTextSummary struct {
	Attention     *dashboardTextAttention `json:"attention"`
	SchemaVersion int                     `json:"schemaVersion"`
	Dashboard     struct {
		ID   string `json:"id"`
		ETag string `json:"etag"`
	} `json:"dashboard"`
	ObservedAt string `json:"observedAt"`
	Range      struct {
		Start       string  `json:"start"`
		End         string  `json:"end"`
		StepSeconds float64 `json:"stepSeconds"`
	} `json:"range"`
	Variables map[string]variablevalue.Value `json:"variables"`
	// VariableDefinitions is each declared variable's label, default and options, as the structured result has them.
	VariableDefinitions []dashboardTextVariable `json:"variableDefinitions"`
	Warnings            []string                `json:"warnings"`
	State               string                  `json:"state"`
	Omitted             []string                `json:"omitted"`
	Widgets             []dashboardTextWidget   `json:"widgets"`
	Signals             []dashboardTextSignal   `json:"signals"`
}

func dashboardQueryText(raw json.RawMessage) (string, error) {
	var summary dashboardTextSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		return "", fmt.Errorf("decode dashboard summary: %w", err)
	}
	if summary.SchemaVersion != 1 || summary.Dashboard.ID == "" || summary.Signals == nil || summary.Widgets == nil {
		return "", errors.New("missing dashboard summary fields")
	}
	var out strings.Builder
	// The attention summary leads, so a text-only client reads the counts before any detail.
	appendDashboardAttentionText(&out, summary.Attention, summary.Widgets)
	appendDashboardHeaderText(&out, &summary)
	appendDashboardOmittedText(&out, summary.Omitted)
	if summary.Variables != nil {
		appendDashboardVariablesText(&out, summary.Variables)
	}
	appendDashboardDeclaredVariablesText(&out, summary.VariableDefinitions)
	appendDashboardWarningsText(&out, summary.Warnings)
	// A widget can fail before it has a signal (for example, a missing saved
	// query). Report these first so a text-only client does not miss the error.
	if appendDashboardWidgetDiagnostics(&out, summary.Widgets) {
		return out.String(), nil
	}
	appendDashboardThresholdsText(&out, summary.Widgets)
	appendDashboardRankingText(&out, summary.Widgets)
	appendDashboardComparisonText(&out, summary.Widgets)
	appendDashboardBreachesText(&out, summary.Widgets)
	appendDashboardSLOText(&out, summary.Widgets)
	for index := range summary.Signals {
		line := dashboardSignalText(&summary.Signals[index], summary.Widgets)
		if out.Len()+len(line)+80 > dashboardQueryTextBytes {
			out.WriteString("More signals are available in structuredContent.\n")
			break
		}
		out.WriteString(line + "\n")
	}
	return out.String(), nil
}

// appendDashboardAttentionText writes the counts of widgets needing attention, then the
// widgets themselves, bounded. It states what is counted, so the counts are not read as a
// health verdict. Nothing is written when the structured output carries no summary.
func appendDashboardAttentionText(out *strings.Builder, attention *dashboardTextAttention, widgets []dashboardTextWidget) {
	if attention == nil {
		return
	}
	summary := "none"
	if counts := dashboardAttentionCountsText(attention); len(counts) > 0 {
		summary = strings.Join(counts, ", ")
	}
	fmt.Fprintf(out, "Attention: %s; %d of %d widgets checked. Declared statuses, failures and staleness only; not a health verdict.\n", summary, attention.Checked, attention.Widgets)
	items, shown, total := dashboardAttentionWidgetsText(widgets)
	if total > 0 {
		fmt.Fprintf(out, "Attention widgets: %s", items)
		if shown < total {
			fmt.Fprintf(out, " (%d more in structuredContent)", total-shown)
		}
		out.WriteByte('\n')
	}
}

// dashboardAttentionCountsText lists the non-zero buckets in reading order.
func dashboardAttentionCountsText(attention *dashboardTextAttention) []string {
	var counts []string
	for _, entry := range []struct {
		name  string
		count int
	}{{"critical", attention.Critical}, {"warning", attention.Warning}, {"failed", attention.Failed}, {"stale", attention.Stale}} {
		if entry.count > 0 {
			counts = append(counts, fmt.Sprintf("%d %s", entry.count, entry.name))
		}
	}
	return counts
}

// dashboardAttentionWidgetsText names the widgets that need attention within a fixed budget.
// It returns the text, how many were named and how many need attention in all.
func dashboardAttentionWidgetsText(widgets []dashboardTextWidget) (text string, shown, total int) {
	var items strings.Builder
	for index := range widgets {
		widget := &widgets[index]
		if widget.Attention == "" {
			continue
		}
		total++
		reason := widget.Attention
		if widget.Type == "timeseries" && (reason == "critical" || reason == "warning") && (widget.Breaches == nil || widget.Breaches.LatestLevel != reason) {
			reason += " in window"
		}
		item := fmt.Sprintf("%s %s", strconv.Quote(shortDashboardText(widget.ID, 80)), reason)
		if items.Len()+len(item)+2 > 600 {
			continue
		}
		if shown > 0 {
			items.WriteString("; ")
		}
		items.WriteString(item)
		shown++
	}
	return items.String(), shown, total
}

// appendDashboardBreachesText describes each time series' breaches in the window: the
// level totals, then the most recent intervals. Bounded, and the structured output
// remains complete.
func appendDashboardBreachesText(out *strings.Builder, widgets []dashboardTextWidget) {
	var lines strings.Builder
	truncated := false
	for index := range widgets {
		widget := &widgets[index]
		if widget.Breaches == nil {
			continue
		}
		line := dashboardBreachLineText(widget)
		if lines.Len()+len(line) > 1000 || out.Len()+lines.Len()+len(line)+128 > dashboardQueryTextBytes {
			truncated = true
			break
		}
		lines.WriteString(line)
	}
	out.WriteString(lines.String())
	if truncated {
		out.WriteString("More breach details are available in structuredContent.\n")
	}
}

// dashboardBreachLineText describes one time series' breaches: the window totals per level, the
// band of the newest sample, and the most recent intervals.
func dashboardBreachLineText(widget *dashboardTextWidget) string {
	var line strings.Builder
	fmt.Fprintf(&line, "widget %s breaches:", strconv.Quote(shortDashboardText(widget.ID, 80)))
	if len(widget.Breaches.Summary) == 0 {
		line.WriteString(" none in the returned window;")
	}
	for _, level := range widget.Breaches.Summary {
		fmt.Fprintf(&line, " %s in window: intervals=%d, merged=%s ms, samples=%d;", strconv.Quote(shortDashboardText(level.Level, 16)), level.Intervals, dashboardNumberText(level.DurationMs), level.Samples)
	}
	if widget.Breaches.LatestLevel != "" {
		fmt.Fprintf(&line, " latest sample: %s now;", strconv.Quote(shortDashboardText(widget.Breaches.LatestLevel, 16)))
	} else {
		line.WriteString(" latest sample: not in a breach band;")
	}
	shown := widget.Breaches.Intervals[max(0, len(widget.Breaches.Intervals)-3):]
	for _, interval := range shown {
		fmt.Fprintf(&line, " [series %d %s %s %s-%s ms]", interval.Series, strconv.Quote(shortDashboardText(interval.Name, 96)), strconv.Quote(shortDashboardText(interval.Level, 16)), dashboardNumberText(interval.Start), dashboardNumberText(interval.End))
	}
	// Intervals listed in structuredContent but not shown here are named apart from intervalsOmitted,
	// which counts intervals that structuredContent does not list at all.
	if listed := len(widget.Breaches.Intervals) - len(shown); listed > 0 {
		fmt.Fprintf(&line, " (%d more listed in structuredContent)", listed)
	}
	if widget.Breaches.IntervalsOmitted > 0 {
		fmt.Fprintf(&line, " (%d not listed)", widget.Breaches.IntervalsOmitted)
	}
	line.WriteByte('\n')
	return line.String()
}

// appendDashboardSLOText describes each slo-summary widget's objective: its state, its reasons, the
// counts and the listed groups. Bounded, and the structured output remains complete.
func appendDashboardSLOText(out *strings.Builder, widgets []dashboardTextWidget) {
	var lines strings.Builder
	truncated := false
	for index := range widgets {
		widget := &widgets[index]
		if widget.SLO == nil {
			continue
		}
		line := dashboardSLOLineText(widget)
		if lines.Len()+len(line) > 1000 || out.Len()+lines.Len()+len(line)+128 > dashboardQueryTextBytes {
			truncated = true
			break
		}
		lines.WriteString(line)
	}
	out.WriteString(lines.String())
	if truncated {
		out.WriteString("More SLO details are available in structuredContent.\n")
	}
}

// dashboardSLOLineText is one slo-summary widget's line. Each percentage uses the widget's decimals, as the card
// does: the objective stays in Auto so it keeps its own value, and a value under 100 never reads as 100.
func dashboardSLOLineText(widget *dashboardTextWidget) string {
	slo := widget.SLO
	var line strings.Builder
	fmt.Fprintf(&line, "widget %s objective %s over %s: state %s", strconv.Quote(shortDashboardText(widget.ID, 80)), dashboardReadingWithUnit(slo.Objective, "%", nil), shortDashboardText(slo.Period, 8), shortDashboardText(slo.State, 16))
	if len(slo.Reasons) > 0 {
		fmt.Fprintf(&line, " (%s)", shortDashboardText(strings.Join(slo.Reasons, ", "), 96))
	}
	fmt.Fprintf(&line, "; meeting=%d at_risk=%d breaching=%d unknown=%d;", slo.Counts.Meeting, slo.Counts.AtRisk, slo.Counts.Breaching, slo.Counts.Unknown)
	for _, group := range slo.Groups {
		availability, budget := sloUnknownWord(group.Reasons), "n/a"
		if group.Availability != nil {
			availability = sloPercentText(*group.Availability, widget.Decimals)
		}
		if group.BudgetRemaining != nil {
			budget = sloPercentText(*group.BudgetRemaining, widget.Decimals)
		}
		fmt.Fprintf(&line, " [%s %s availability %s budget %s]", shortDashboardText(sloLabelsText(group.Labels), 96), shortDashboardText(group.State, 16), availability, budget)
	}
	if slo.GroupsOmitted > 0 {
		noun := "groups"
		if slo.GroupsOmitted == 1 {
			noun = "group"
		}
		fmt.Fprintf(&line, " (%d more %s in structuredContent)", slo.GroupsOmitted, noun)
	}
	line.WriteByte('\n')
	return line.String()
}

// sloUnknownWord says why a group has no availability. A truncated result is not traffic, so it never reads as
// "no traffic": an agent must not take a dropped series for zero requests.
func sloUnknownWord(reasons []string) string {
	for _, reason := range reasons {
		switch reason {
		case "incomplete":
			return "not proven (truncated)"
		case "no_traffic":
			return "no traffic"
		}
	}
	return "no data"
}

// sloPercentText is a percentage at the widget's decimals. Fixed decimals can round a value under 100 up to 100,
// so that case falls back to Auto, as the card does. A negative value keeps its sign too: an overspend of 0.04% at
// zero decimals would read as "0%", so that case also falls back to Auto.
func sloPercentText(value float64, decimals *int) string {
	text := dashboardReadingWithUnit(value, "%", decimals)
	if value < 100 && strings.HasPrefix(text, "100") {
		return dashboardReadingWithUnit(value, "%", nil)
	}
	if value < 0 && isZeroPercentText(text) {
		return dashboardReadingWithUnit(value, "%", nil)
	}
	return text
}

// isZeroPercentText reports whether a percentage text is zero with or without its sign, such as "0%" or "-0.0%".
func isZeroPercentText(text string) bool {
	return strings.Trim(strings.TrimPrefix(text, "-"), "0.%") == ""
}

// sloLabelsText is the group's labels as name=value pairs in name order, or "all" for an ungrouped objective.
func sloLabelsText(labels map[string]string) string {
	if len(labels) == 0 {
		return "all"
	}
	names := make([]string, 0, len(labels))
	for name := range labels {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, name+"="+labels[name])
	}
	return strings.Join(parts, ",")
}

// dashboardOmissionPhrases says what each name in the structured omitted list dropped, for text
// readers. The names match the server's ladder; an unknown name is shown as it is.
var dashboardOmissionPhrases = map[string]string{
	"variableOptions": "variable source values (state, counts and currentValue kept)",
	"breachIntervals": "listed breach intervals and their series names (window summaries kept)",
	"rankingRows":     "ranked row previews and their columns and statuses (counts and hidden rows kept)",
	"breaches":        "per-widget breach objects",
	"bandSeries":      "band series objects (their drawn and omitted counts too)",
	"sample":          "time-series freshness, the limit, lastTimestamp and age of stale samples, samples whose state is not stale, and stale samples on widgets already marked stale",
	"sloBurn":         "burn windows of slo-summary groups (state, reasons and budget kept)",
}

// appendDashboardOmittedText states what was dropped to fit the result cap, in the order it was
// dropped, so a text-only reader knows the structured output has less detail than the widgets had.
func appendDashboardOmittedText(out *strings.Builder, omitted []string) {
	if len(omitted) == 0 {
		return
	}
	phrases := make([]string, 0, len(omitted))
	for _, name := range omitted {
		phrase, known := dashboardOmissionPhrases[name]
		if !known {
			phrase = shortDashboardText(name, 40)
		}
		phrases = append(phrases, phrase)
	}
	fmt.Fprintf(out, "Omitted from structuredContent to fit the result cap, in this order: %s. Attention counts are unchanged. Narrow the query with widget_ids to get the omitted detail back.\n", strings.Join(phrases, "; "))
}

func appendDashboardHeaderText(out *strings.Builder, summary *dashboardTextSummary) {
	fmt.Fprintf(out, "Dashboard %s: %s. Structured content is authoritative; state is data availability, not health.\n", strconv.Quote(shortDashboardText(summary.Dashboard.ID, 80)), shortDashboardText(summary.State, 24))
	if summary.Range.Start != "" && summary.Range.End != "" {
		fmt.Fprintf(out, "Range %s to %s; step=%ss", strconv.Quote(shortDashboardText(summary.Range.Start, 80)), strconv.Quote(shortDashboardText(summary.Range.End, 80)), strconv.FormatFloat(summary.Range.StepSeconds, 'g', -1, 64))
		if summary.ObservedAt != "" {
			fmt.Fprintf(out, "; observed at %s", strconv.Quote(shortDashboardText(summary.ObservedAt, 80)))
		}
		if summary.Dashboard.ETag != "" {
			fmt.Fprintf(out, "; dashboard ETag=%s", strconv.Quote(shortDashboardText(summary.Dashboard.ETag, 120)))
		}
		out.WriteByte('\n')
	}
}

func appendDashboardWidgetDiagnostics(out *strings.Builder, widgets []dashboardTextWidget) bool {
	for index := range widgets {
		widget := &widgets[index]
		// Freshness is described only where a limit judges it; an unjudged age stays in the
		// structured output.
		if line, judged := dashboardFreshnessText(widget); judged {
			if out.Len()+len(line)+80 > dashboardQueryTextBytes {
				out.WriteString("More widget details and signals are available in structuredContent.\n")
				return true
			}
			out.WriteString(line)
		}
		for _, detail := range []struct {
			suffix string
			err    *dashboardTextError
		}{{"", widget.Error}, {" events", widget.AnnotationError}} {
			if detail.err == nil {
				continue
			}
			line := fmt.Sprintf("widget %s %s%s: error %s: %s", strconv.Quote(shortDashboardText(widget.ID, 80)), strconv.Quote(shortDashboardText(widget.Title, 160)), detail.suffix, strconv.Quote(shortDashboardText(detail.err.Code, 80)), strconv.Quote(shortDashboardText(detail.err.Message, 240)))
			if out.Len()+len(line)+80 > dashboardQueryTextBytes {
				out.WriteString("More widget errors and signals are available in structuredContent.\n")
				return true
			}
			out.WriteString(line + "\n")
		}
	}
	return false
}

// dashboardNumberText formats a reading for text: six significant digits, so floating-point noise such as
// 5.878749999999975 reads as 5.87875. Integers below 1e15 keep every digit (1234567 stays whole), because a count or an
// identifier read as an exponent loses its exactness. Non-integers below 1e15 keep six significant digits in fixed
// notation (1234567.5 reads as 1234568, 0.0123456789 as 0.0123457), never an exponent. Structured content keeps the
// exact number.
func dashboardNumberText(value float64) string {
	if value == 0 {
		return "0"
	}
	magnitude := math.Abs(value)
	if value == math.Trunc(value) && magnitude < 1e15 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	if magnitude >= 1e15 || magnitude < 1e-4 || math.IsNaN(value) || math.IsInf(value, 0) {
		return dashboardTrimExponent(strconv.FormatFloat(value, 'g', 6, 64))
	}
	places := max(0, 5-int(math.Floor(math.Log10(magnitude))))
	text := strconv.FormatFloat(value, 'f', places, 64)
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	return text
}

// appendDashboardBandText writes a matched band's boundary, then its status, colour and label, printing only the
// fields the band names.
func appendDashboardBandText(line *strings.Builder, threshold *dashboardTextThreshold, unit string, decimals *int) {
	if threshold.Boundary != nil {
		fmt.Fprintf(line, "; boundary=%s", dashboardReadingWithUnit(*threshold.Boundary, unit, decimals))
	}
	if threshold.Status != "" {
		fmt.Fprintf(line, "; status=%s", strconv.Quote(shortDashboardText(threshold.Status, 16)))
	}
	if threshold.Color != "" {
		fmt.Fprintf(line, "; color=%s", strconv.Quote(shortDashboardText(threshold.Color, 16)))
	}
	if threshold.Label != "" {
		fmt.Fprintf(line, "; label=%s", strconv.Quote(shortDashboardText(threshold.Label, 80)))
	}
}

// dashboardFreshnessText describes a widget whose sample is judged. The sample names the limit
// and its basis; a document from the first contract carries only the freshness object.
func dashboardFreshnessText(widget *dashboardTextWidget) (string, bool) {
	id := strconv.Quote(shortDashboardText(widget.ID, 80))
	if sample := widget.Sample; sample != nil && sample.Basis != "" && sample.StaleAfterSeconds != nil {
		limit := dashboardNumberText(*sample.StaleAfterSeconds) + "s"
		if sample.Basis == "cadence" {
			limit += ", twice the longest cadence"
		}
		line := fmt.Sprintf("widget %s: returned sample freshness=%s (threshold %s", id, sample.State, limit)
		if sample.AgeSeconds != nil {
			line += fmt.Sprintf(", age %.0fs", *sample.AgeSeconds)
		}
		return line + "); relative to range end, not scrape health\n", true
	}
	if widget.Freshness == nil || widget.Freshness.ThresholdSeconds == nil {
		return "", false
	}
	line := fmt.Sprintf("widget %s: returned sample freshness=%s (threshold %ds", id, widget.Freshness.State, *widget.Freshness.ThresholdSeconds)
	if widget.Freshness.AgeSeconds != nil {
		line += fmt.Sprintf(", age %.0fs", *widget.Freshness.AgeSeconds)
	}
	return line + "); relative to range end, not scrape health\n", true
}

// appendDashboardBandSeriesText says which series set a multi-series band and how many the
// visualization drew, so a reader can tell a band from a series it never shows.
func appendDashboardBandSeriesText(line *strings.Builder, bands *dashboardTextBandSeries) {
	if bands == nil {
		return
	}
	if bands.Series != nil {
		fmt.Fprintf(line, "; series=%d name=%s", *bands.Series, strconv.Quote(shortDashboardText(bands.Name, 96)))
	}
	fmt.Fprintf(line, "; evaluated=%d omitted=%d", bands.Evaluated, bands.Omitted)
}

// appendDashboardComparisonText names each stat's change against its earlier window. A state other than ok or partial
// says why there is no change, and not_run is never read as no change.
func appendDashboardComparisonText(out *strings.Builder, widgets []dashboardTextWidget) {
	for index := range widgets {
		widget := &widgets[index]
		if widget.Comparison == nil {
			continue
		}
		compare := widget.Comparison
		var line strings.Builder
		fmt.Fprintf(&line, "widget %s: change vs %s earlier: state=%s", strconv.Quote(shortDashboardText(widget.ID, 80)), comparisonWindowText(compare), strconv.Quote(shortDashboardText(compare.State, 24)))
		// The change follows the widget's decimals, as the displayed reading does. A percentage keeps its own unit.
		// A change that rounds to nothing reads as "≈0", with no sign.
		if compare.Delta != nil {
			fmt.Fprintf(&line, " delta=%s", shortDashboardText(comparisonChangeText(*compare.Delta, compare.ChangeUnit, widget.Decimals, compare.Direction == "flat"), 80))
		}
		if compare.Percent != nil {
			fmt.Fprintf(&line, " percent=%s", shortDashboardText(comparisonChangeText(*compare.Percent, "%", widget.Decimals, compare.Direction == "flat"), 40))
		}
		if compare.Direction != "" {
			fmt.Fprintf(&line, " direction=%s", compare.Direction)
		}
		if compare.Assessment != "" {
			fmt.Fprintf(&line, " assessment=%s", compare.Assessment)
		}
		if compare.Reason != "" {
			fmt.Fprintf(&line, " reason=%s", strconv.Quote(shortDashboardText(compare.Reason, 48)))
		}
		line.WriteByte('\n')
		if out.Len()+line.Len()+128 > dashboardQueryTextBytes {
			return
		}
		out.WriteString(line.String())
	}
}

// appendDashboardRankingText says how a ranked record table's loaded rows rank: the declared critical and
// warning counts, the top row and any truncation. Counts are whole numbers, and the ranking covers only
// the rows that were loaded.
func appendDashboardRankingText(out *strings.Builder, widgets []dashboardTextWidget) {
	for index := range widgets {
		widget := &widgets[index]
		if widget.Ranking == nil || widget.Ranking.Counts == nil {
			continue
		}
		line := rankingTextLine(widget.Title, widget.Ranking, widget.Decimals)
		if out.Len()+len(line)+128 > dashboardQueryTextBytes {
			return
		}
		out.WriteString(line)
	}
}

// rankingTextLine is one ranked table's synopsis line, ending in a newline.
func rankingTextLine(title string, ranking *dashboardTextRanking, decimals *int) string {
	var line strings.Builder
	fmt.Fprintf(&line, "ranked %s: critical=%d warning=%d of %d loaded", strconv.Quote(shortDashboardText(title, 80)), ranking.Counts["critical"], ranking.Counts["warning"], ranking.Evaluated)
	if len(ranking.Rows) > 0 && len(ranking.Rows[0]) > 0 {
		if top, ok := rankingCellText(ranking.Rows[0][0], decimals); ok {
			fmt.Fprintf(&line, "; top: %s", shortDashboardText(top, 80))
		}
	}
	if ranking.Hidden != nil && ranking.Hidden.Rows > 0 {
		fmt.Fprintf(&line, "; %d rows not shown (critical %d, warning %d)", ranking.Hidden.Rows, ranking.Hidden.Critical, ranking.Hidden.Warning)
	}
	if ranking.Partial && ranking.Reason != "" {
		fmt.Fprintf(&line, "; %s", shortDashboardText(ranking.Reason, 120))
	}
	line.WriteByte('\n')
	return line.String()
}

// Keep visual-band context bounded independently of data signals. These are
// authored thresholds, not inferred health or alert states.
func appendDashboardThresholdsText(out *strings.Builder, widgets []dashboardTextWidget) {
	var lines strings.Builder
	total, shown := 0, 0
	for index := range widgets {
		widget := &widgets[index]
		if widget.Threshold == nil {
			continue
		}
		total++
		var line strings.Builder
		fmt.Fprintf(&line, "widget %s: configured visual band=%s", strconv.Quote(shortDashboardText(widget.ID, 80)), strconv.Quote(shortDashboardText(widget.Threshold.State, 24)))
		if widget.Threshold.State == "matched" {
			appendDashboardBandText(&line, widget.Threshold, widget.Unit, widget.Decimals)
		}
		appendDashboardBandSeriesText(&line, widget.BandSeries)
		line.WriteByte('\n')
		if lines.Len()+line.Len() <= 1000 && out.Len()+lines.Len()+line.Len()+128 <= dashboardQueryTextBytes {
			lines.WriteString(line.String())
			shown++
		}
	}
	out.WriteString(lines.String())
	if shown < total && out.Len()+100 < dashboardQueryTextBytes {
		fmt.Fprintf(out, "%d visual bands omitted; see structuredContent.\n", total-shown)
	}
}

// Variables are the effective values for this snapshot (saved defaults plus
// overrides), not necessarily user overrides. Bound the synopsis separately so
// long untrusted labels cannot crowd out errors and other signals.
func appendDashboardVariablesText(out *strings.Builder, variables map[string]variablevalue.Value) {
	keys := make([]string, 0, len(variables))
	for key := range variables {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out.WriteString("Selected variables:")
	if len(keys) == 0 {
		out.WriteString(" none\n")
		return
	}
	var entries strings.Builder
	shown := 0
	for _, key := range keys {
		item := fmt.Sprintf(" %s=%s", strconv.Quote(shortDashboardText(key, 48)), variableValueText(variables[key], 96))
		if entries.Len()+len(item) > 1000 {
			break
		}
		entries.WriteString(item)
		shown++
	}
	out.WriteString(entries.String())
	if shown < len(keys) {
		fmt.Fprintf(out, " (%d variables omitted; see structuredContent)", len(keys)-shown)
	}
	out.WriteByte('\n')
}

// dashboardTextVariable is one declared variable as the structured result reports it, read for the synopsis.
type dashboardTextVariable struct {
	Name            string               `json:"name"`
	Label           string               `json:"label"`
	DefaultValue    *variablevalue.Value `json:"defaultValue"`
	Options         []string             `json:"options"`
	Source          string               `json:"source"`
	FallbackOptions []string             `json:"fallbackOptions"`
	OptionsOmitted  int                  `json:"optionsOmitted"`
	DetailOmitted   bool                 `json:"detailOmitted"`
	// SourceOptions is the sourced variable's resolution for this call, when the result reports one.
	SourceOptions *dashboardTextSourceOptions `json:"sourceOptions"`
}

// dashboardTextSourceOptions is a sourced variable's resolution as the structured result reports it.
type dashboardTextSourceOptions struct {
	State         string                  `json:"state"`
	Values        []string                `json:"values"`
	ValuesOmitted int                     `json:"valuesOmitted"`
	CurrentValue  string                  `json:"currentValue"`
	NeedsVariable string                  `json:"needsVariable"`
	Error         *dashboardTextSourceErr `json:"error"`
}

type dashboardTextSourceErr struct {
	Code string `json:"code"`
}

const (
	dashboardTextVariableOptions = 8    // Options named per variable; the rest are counted.
	dashboardTextVariableBytes   = 1000 // The synopsis line's bound; later variables are counted, not named.
)

// appendDashboardDeclaredVariablesText names each declared variable with its label, default and options, so a
// text-only client can choose values without a get_dashboard read. Structured content holds the full definitions.
func appendDashboardDeclaredVariablesText(out *strings.Builder, definitions []dashboardTextVariable) {
	if len(definitions) == 0 {
		return
	}
	var entries strings.Builder
	shown := 0
	for index := range definitions {
		entry := declaredVariableText(&definitions[index])
		if shown > 0 && entries.Len()+len(entry) > dashboardTextVariableBytes {
			break
		}
		if shown > 0 {
			entries.WriteString("; ")
		}
		entries.WriteString(entry)
		shown++
	}
	out.WriteString("Declared variables: ")
	out.WriteString(entries.String())
	if shown < len(definitions) {
		fmt.Fprintf(out, " (%d more; see structuredContent)", len(definitions)-shown)
	}
	out.WriteString(".\n")
}

// declaredVariableText is one variable's entry in the declared-variables line: its quoted name, then its label,
// default and the first options it names, with the count of the rest.
// sourcedVariableStateText says what a sourced variable resolved to for this call. Each state names its own
// outcome in plain words, so an agent knows whether the values are usable without reading structuredContent.
func sourcedVariableStateText(definition *dashboardTextVariable) string {
	options := definition.SourceOptions
	switch options.State {
	case "ready":
		return readySourceValuesText(definition)
	case "empty":
		return "; its source returned no values"
	case "failed":
		if options.Error == nil || options.Error.Code == "" {
			return "; its source failed"
		}
		return "; its source failed (" + options.Error.Code + ")"
	case "needs_variable":
		return "; set " + options.NeedsVariable + " to load its values"
	case "not_run":
		return "; its source was not queried in time"
	}
	return ""
}

// readySourceValuesText names the first values a ready source returned, and says how many more there are.
func readySourceValuesText(definition *dashboardTextVariable) string {
	options := definition.SourceOptions
	named := make([]string, 0, dashboardTextVariableOptions)
	for index, value := range options.Values {
		if index == dashboardTextVariableOptions {
			break
		}
		named = append(named, strconv.Quote(shortDashboardText(value, 48)))
	}
	text := " values from its " + definition.Source + " source " + strings.Join(named, ", ")
	if more := len(options.Values) - len(named) + options.ValuesOmitted; more > 0 {
		text += fmt.Sprintf(" (+%d more; see structuredContent)", more)
	}
	if options.CurrentValue == "not_in_values" {
		text += " (current value not in source values; kept)"
	}
	return text
}

func declaredVariableText(definition *dashboardTextVariable) string {
	entry := variableIdentityText(definition)
	if definition.Source != "" && definition.SourceOptions != nil {
		return entry + sourcedVariableStateText(definition) + detailOmittedText(definition)
	}
	return entry + declaredOptionsText(definition) + detailOmittedText(definition)
}

// variableIdentityText names a variable with its label and saved default.
func variableIdentityText(definition *dashboardTextVariable) string {
	entry := strconv.Quote(shortDashboardText(definition.Name, 48))
	if definition.Label != "" {
		entry += " (" + strconv.Quote(shortDashboardText(definition.Label, 48)) + ")"
	}
	if definition.DefaultValue != nil {
		entry += " default " + variableValueText(*definition.DefaultValue, 96)
	}
	return entry
}

// variableValueText renders a variable value for the synopsis: a quoted string, All for an empty list, or a
// bracketed list of quoted items. The whole text is bounded to limit, cut on the text's own characters.
func variableValueText(value variablevalue.Value, limit int) string {
	if !value.List {
		text, _ := value.Text()
		return strconv.Quote(shortDashboardText(text, limit))
	}
	if len(value.Items) == 0 {
		return "All"
	}
	items := make([]string, 0, len(value.Items))
	for _, item := range value.Items {
		items = append(items, strconv.Quote(shortDashboardText(item, 48)))
	}
	return "[" + shortDashboardText(strings.Join(items, ","), limit) + "]"
}

// declaredOptionsText names a variable's static options. A sourced variable whose resolution the result omits
// takes its values from its source; its static options are only a fallback, so they are labelled as such and the
// agent is told to pass an explicit value.
func declaredOptionsText(definition *dashboardTextVariable) string {
	var entry string
	options, label := definition.Options, " options "
	if definition.Source != "" {
		entry += " takes its values from a " + definition.Source + " source; pass an explicit value"
		options, label = definition.FallbackOptions, "; fallback options "
	}
	named := make([]string, 0, dashboardTextVariableOptions)
	for index, option := range options {
		if index == dashboardTextVariableOptions {
			break
		}
		named = append(named, strconv.Quote(shortDashboardText(option, 48)))
	}
	if len(named) > 0 {
		entry += label + strings.Join(named, ", ")
	}
	if more := len(options) - len(named) + definition.OptionsOmitted; more > 0 {
		if len(named) == 0 {
			entry += strings.TrimRight(label, " ")
		}
		entry += fmt.Sprintf(" (+%d more; see structuredContent)", more)
	}
	return entry
}

// detailOmittedText says the label and default were left out of the result's detail budget.
func detailOmittedText(definition *dashboardTextVariable) string {
	if definition.DetailOmitted {
		return " (label and default omitted; see structuredContent)"
	}
	return ""
}

// appendDashboardWarningsText names each warning the call returned, quoted and bounded. An override outside
// a variable's declared options is still applied, so the warning says what was accepted, not what failed.
func appendDashboardWarningsText(out *strings.Builder, warnings []string) {
	const shown = 5
	for index, warning := range warnings {
		if index == shown {
			fmt.Fprintf(out, "Warnings: %d more; see structuredContent.\n", len(warnings)-shown)
			return
		}
		fmt.Fprintf(out, "Warning: %s.\n", strconv.Quote(shortDashboardText(warning, 200)))
	}
}

func dashboardSignalIdentity(signalID string, widgets []dashboardTextWidget) (title, unit, view string, decimals *int, matched int) {
	title = signalID
	for index := range widgets {
		widget := &widgets[index]
		if widget.SignalID == signalID {
			matched++
			if matched == 1 {
				title, unit, view, decimals = widget.Title, widget.Unit, widget.Type, widget.Decimals
				if widget.Type == "plugin" && widget.PluginID != "" {
					view = widget.PluginID
				}
			}
		}
	}
	if title == signalID {
		title = dashboardAnnotationTitle(signalID, title, widgets)
	}
	return title, unit, view, decimals, matched
}

func dashboardAnnotationTitle(signalID, fallback string, widgets []dashboardTextWidget) string {
	for index := range widgets {
		if widgets[index].AnnotationSignalID == signalID {
			return widgets[index].Title + " events"
		}
	}
	return fallback
}

func dashboardSignalText(signal *dashboardTextSignal, widgets []dashboardTextWidget) string {
	title, unit, view, decimals, matched := dashboardSignalIdentity(signal.ID, widgets)
	var line strings.Builder
	fmt.Fprintf(&line, "%s %s: %s", signal.ID, strconv.Quote(shortDashboardText(title, 160)), signal.State)
	if view != "" {
		fmt.Fprintf(&line, "; first view=%s", strconv.Quote(shortDashboardText(view, 80)))
		if matched > 1 {
			fmt.Fprintf(&line, "; shared widgets=%d", matched)
		}
	}
	appendDashboardSignalMetadata(&line, signal)
	appendDashboardPrimaryText(&line, signal, unit, decimals)
	appendDashboardSignalSeries(&line, signal, unit, decimals)
	if signal.Traces != nil {
		fmt.Fprintf(&line, "; returned traces=%d (bounded sample)", signal.Traces.Returned)
		if signal.Traces.ExamplesTruncated || signal.Traces.MetadataTruncated {
			line.WriteString("; trace preview truncated")
		}
		appendDashboardTraceText(&line, signal.Traces)
	}
	// A row cap is a bounded page, not a partial source, so it names only the
	// row limit. Partial and warned responses keep the partial wording.
	sourcePartial := signal.ProviderTruncated && signal.ProviderTruncation != "row_limit"
	appendDashboardRecordText(&line, signal.Records, sourcePartial, signal.ProviderTruncation, decimals)
	appendDashboardTruncationText(&line, signal, sourcePartial)
	return line.String()
}

// appendDashboardProviderReasonText names the source's truncation reason. A
// truncated source that reports no reason says only that, so it does not claim
// a partial response it never reported.
func appendDashboardProviderReasonText(line *strings.Builder, signal *dashboardTextSignal, sourcePartial bool) {
	switch signal.ProviderTruncation {
	case "row_limit":
		line.WriteString("; source row limit")
	case "partial", "provider_warning":
		line.WriteString("; provider partial")
	default:
		if signal.Records == nil && sourcePartial {
			line.WriteString(dashboardUnreportedReasonText)
		}
	}
}

func appendDashboardTruncationText(line *strings.Builder, signal *dashboardTextSignal, sourcePartial bool) {
	appendDashboardProviderReasonText(line, signal, sourcePartial)
	recordsExplainTruncation := dashboardRecordsTruncated(signal.Records)
	tracesExplainTruncation := dashboardTracesTruncated(signal.Traces)
	if signal.Truncated && !signal.ProviderTruncated && !signal.SeriesTruncated && !recordsExplainTruncation && !tracesExplainTruncation {
		line.WriteString("; bounded signal truncated")
	}
}

func dashboardRecordsTruncated(records *dashboardTextRecords) bool {
	return records != nil && (records.RowsTruncated || records.MetadataTruncated || records.ColumnsOmitted > 0)
}

func dashboardTracesTruncated(traces *dashboardTextTraces) bool {
	return traces != nil && (traces.ExamplesTruncated || traces.MetadataTruncated)
}

func appendDashboardPrimaryText(line *strings.Builder, signal *dashboardTextSignal, unit string, decimals *int) {
	if signal.PrimarySeries == nil {
		return
	}
	for index := range signal.Series {
		series := &signal.Series[index]
		if series.Index != *signal.PrimarySeries || series.Last == nil {
			continue
		}
		number, displayUnit := dashboardReading(series.Last.Value, unit, decimals)
		fmt.Fprintf(line, "; latest valid=%s %s at %s ms", number, strconv.Quote(shortDashboardText(displayUnit, 48)), strconv.FormatFloat(series.Last.Timestamp, 'f', -1, 64))
		if series.Mean != nil {
			mean, meanUnit := dashboardReading(*series.Mean, unit, decimals)
			fmt.Fprintf(line, "; sample mean=%s %s", mean, strconv.Quote(shortDashboardText(meanUnit, 48)))
		}
		if series.TailMissing {
			line.WriteString("; latest observation missing")
		}
		break
	}
}

func appendDashboardSignalMetadata(line *strings.Builder, signal *dashboardTextSignal) {
	if signal.Kind != "" {
		fmt.Fprintf(line, "; kind=%s", strconv.Quote(shortDashboardText(signal.Kind, 24)))
	}
	if signal.ProviderID != "" {
		fmt.Fprintf(line, "; provider=%s", strconv.Quote(shortDashboardText(signal.ProviderID, 128)))
	}
	if signal.StepSeconds != nil {
		fmt.Fprintf(line, "; step=%ss", strconv.FormatFloat(*signal.StepSeconds, 'g', -1, 64))
	}
	if signal.SeriesReturned != nil && signal.SeriesOmitted != nil {
		fmt.Fprintf(line, "; returned series=%d (bounded response), omitted summaries=%d", *signal.SeriesReturned, *signal.SeriesOmitted)
	}
	if signal.Error != nil {
		fmt.Fprintf(line, "; error %s: %s", strconv.Quote(shortDashboardText(signal.Error.Code, 80)), strconv.Quote(shortDashboardText(signal.Error.Message, 240)))
	}
}

func appendDashboardSignalSeries(line *strings.Builder, signal *dashboardTextSignal, unit string, decimals *int) {
	if len(signal.Series) != 0 {
		fmt.Fprintf(line, "; series=%d", len(signal.Series))
		duplicates := 0
		for _, series := range signal.Series {
			duplicates += series.DuplicateObservations
		}
		if duplicates > 0 {
			fmt.Fprintf(line, "; duplicate timestamp observations=%d in summarized series (additional samples; some charts require aggregation)", duplicates)
		}
	}
	// A multi-series chart is often the actual operational signal (e.g. one
	// rate per service). The primary value alone is not a representation of the
	// other series. Keep text-only clients useful while bounding this synopsis;
	// complete identities and samples remain in structuredContent.
	if len(signal.Series) > 1 {
		appendDashboardSeriesText(line, signal.Series, unit, decimals)
	}
	if signal.SeriesTruncated {
		line.WriteString("; series preview truncated")
	}
}

// Describe only returned trace samples, never total traffic. Keep this text
// independently bounded so a verbose backend cannot hide later signals.
func appendDashboardTraceText(line *strings.Builder, traces *dashboardTextTraces) {
	appendDashboardTraceCounts(line, traces.StatusCounts)
	var details strings.Builder
	shown := 0
	for _, example := range traces.Examples {
		var item strings.Builder
		fmt.Fprintf(&item, " [trace=%s", strconv.Quote(shortDashboardText(example.TraceID, 64)))
		if example.Service != "" {
			fmt.Fprintf(&item, " service=%s", strconv.Quote(shortDashboardText(example.Service, 64)))
		}
		if example.Operation != "" {
			fmt.Fprintf(&item, " operation=%s", strconv.Quote(shortDashboardText(example.Operation, 80)))
		}
		fmt.Fprintf(&item, " status=%s", strconv.Quote(shortDashboardText(example.Status, 32)))
		if example.DurationMs != nil {
			fmt.Fprintf(&item, " duration=%s ms", dashboardNumberText(*example.DurationMs))
		}
		if example.StartTime != nil {
			fmt.Fprintf(&item, " start=%s ms", dashboardNumberText(*example.StartTime))
		}
		if example.InvalidFields {
			item.WriteString("; invalid fields")
		}
		item.WriteByte(']')
		if details.Len()+item.Len() > 1000 {
			break
		}
		details.WriteString(item.String())
		shown++
	}
	if len(traces.Examples) > 0 {
		line.WriteString("; trace examples:")
		line.WriteString(details.String())
		if shown < len(traces.Examples) {
			fmt.Fprintf(line, " (%d trace examples omitted; see structuredContent)", len(traces.Examples)-shown)
		}
	}
}

func appendDashboardTraceCounts(line *strings.Builder, counts map[string]int) {
	if len(counts) > 0 {
		keys := make([]string, 0, len(counts))
		for key := range counts {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		line.WriteString("; sample status counts:")
		for _, key := range keys[:min(len(keys), 4)] {
			fmt.Fprintf(line, " %s=%d", strconv.Quote(shortDashboardText(key, 32)), counts[key])
		}
		if len(keys) > 4 {
			fmt.Fprintf(line, " (%d statuses omitted; see structuredContent)", len(keys)-4)
		}
	}
}

const dashboardSeriesTextBytes = 1000

func appendDashboardSeriesText(line *strings.Builder, entries []dashboardTextSeries, unit string, decimals *int) {
	var synopsis strings.Builder
	shown := 0
	for index := range entries {
		item := dashboardSeriesItemText(&entries[index], unit, decimals)
		if synopsis.Len()+len(item) > dashboardSeriesTextBytes {
			break
		}
		synopsis.WriteString(item)
		shown++
	}
	line.WriteString("; series details:")
	line.WriteString(synopsis.String())
	if shown < len(entries) {
		fmt.Fprintf(line, " (%d series details omitted; see structuredContent)", len(entries)-shown)
	}
}

func dashboardSeriesItemText(entry *dashboardTextSeries, unit string, decimals *int) string {
	var item strings.Builder
	fmt.Fprintf(&item, " [#%d", entry.Index)
	if entry.Name != "" && entry.Name != canonicalDashboardSeriesName(entry.Labels) {
		fmt.Fprintf(&item, " name=%s", strconv.Quote(shortDashboardText(entry.Name, 64)))
	}
	keys := make([]string, 0, len(entry.Labels))
	for key := range entry.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys[:min(len(keys), 3)] {
		fmt.Fprintf(&item, " %s=%s", strconv.Quote(shortDashboardText(key, 40)), strconv.Quote(shortDashboardText(entry.Labels[key], 48)))
	}
	if len(keys) > 3 {
		fmt.Fprintf(&item, " +%d labels", len(keys)-3)
	}
	if entry.Last == nil {
		item.WriteString("; no valid observation")
	} else {
		number, displayUnit := dashboardReading(entry.Last.Value, unit, decimals)
		fmt.Fprintf(&item, "; last valid=%s %s at %s ms", number, strconv.Quote(shortDashboardText(displayUnit, 48)), strconv.FormatFloat(entry.Last.Timestamp, 'f', -1, 64))
	}
	if entry.Mean != nil {
		mean, meanUnit := dashboardReading(*entry.Mean, unit, decimals)
		fmt.Fprintf(&item, "; sample mean=%s %s", mean, strconv.Quote(shortDashboardText(meanUnit, 48)))
	}
	if entry.TailMissing {
		item.WriteString("; latest observation missing")
	}
	item.WriteByte(']')
	return item.String()
}

// Prometheus-generated names repeat their labels. Omit only an exact match;
// an authored alias or partially bounded identity remains visible.
func canonicalDashboardSeriesName(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		if key != "__name__" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var name strings.Builder
	name.WriteString(labels["__name__"])
	if len(keys) > 0 {
		name.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				name.WriteString(", ")
			}
			name.WriteString(key)
			name.WriteByte('=')
			name.WriteString(strconv.Quote(labels[key]))
		}
		name.WriteByte('}')
	}
	return name.String()
}

// dashboardUnreportedReasonText is the text for a truncated source that reports
// no reason. The reason is unknown, so the text does not name a partial source.
const dashboardUnreportedReasonText = "; source truncated (reason not reported)"

func appendDashboardRecordText(line *strings.Builder, records *dashboardTextRecords, providerTruncated bool, providerReason string, decimals *int) {
	if records == nil {
		return
	}
	fmt.Fprintf(line, "; returned records=%d (bounded page)", records.Returned)
	if records.RowsTruncated || records.MetadataTruncated || records.ColumnsOmitted > 0 {
		line.WriteString("; record preview truncated")
	}
	if records.ColumnsOmitted > 0 {
		fmt.Fprintf(line, "; omitted columns=%d", records.ColumnsOmitted)
	}
	if providerTruncated {
		if providerReason == "partial" || providerReason == "provider_warning" {
			line.WriteString("; partial source response")
		} else {
			line.WriteString(dashboardUnreportedReasonText)
		}
	}
	appendDashboardRecordPreview(line, records, decimals)
}

func appendDashboardRecordPreview(line *strings.Builder, records *dashboardTextRecords, decimals *int) {
	if len(records.Rows) == 0 {
		return
	}
	row := records.Rows[0]
	count := min(3, len(row), len(records.Columns))
	if count == 0 {
		return
	}
	fmt.Fprintf(line, "; first record (%d/%d columns): ", count, len(records.Columns)+records.ColumnsOmitted)
	for index := range count {
		if index > 0 {
			line.WriteString(", ")
		}
		column := records.Columns[index]
		unit := column.Unit
		if unit == "percent" {
			unit = "%"
		}
		fmt.Fprintf(line, "%s=%s", strconv.Quote(shortDashboardText(column.Key, 48)), dashboardRecordScalarText(row[index], unit, decimals))
	}
}

// dashboardRecordScalarText prints one record cell. A number with a unit takes the column's unit family and the widget's
// decimal places, as a table cell does, so no cell prints an unscaled 15-digit value. A unit-less number keeps its
// stored digits: it may be an identifier or a year, and float noise is never printed.
func dashboardRecordScalarText(raw json.RawMessage, unit string, decimals *int) string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return "[unavailable]"
	}
	switch value := value.(type) {
	case nil:
		return "null"
	case string:
		return strconv.Quote(shortDashboardText(value, 80))
	case bool:
		return strconv.FormatBool(value)
	case json.Number:
		text := value.String()
		if unit == "" && !strings.ContainsAny(text, ".eE") {
			return shortDashboardText(text, 80)
		}
		if reading, err := strconv.ParseFloat(text, 64); err == nil {
			return shortDashboardText(dashboardReadingWithUnit(reading, unit, decimals), 80)
		}
		return shortDashboardText(text, 80)
	default:
		return "[unavailable]"
	}
}

func shortDashboardText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return value[:limit] + "…"
}

// rankingCellText reads a ranked row's first cell for the synopsis. A number follows the widget's decimals, so
// no float noise is printed; a string is printed as stored. Other cells are not named.
func rankingCellText(cell any, decimals *int) (string, bool) {
	switch typed := cell.(type) {
	case string:
		return typed, true
	case float64:
		return dashboardReadingWithUnit(typed, "", decimals), true
	}
	return "", false
}
