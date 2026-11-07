package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const dashboardQueryResponseBytes = 128 << 10
const dashboardQueryTextBytes = 8 << 10

type dashboardQueryAdmissionKey struct{}

// WithDashboardQueryAdmission records whether the HTTP admission layer acquired
// a dashboard orchestration slot. The marker is server-owned, never derived from
// a client header. Direct/in-process callers without HTTP admission are allowed.
func WithDashboardQueryAdmission(ctx context.Context, admitted bool) context.Context {
	return context.WithValue(ctx, dashboardQueryAdmissionKey{}, admitted)
}

func requireDashboardQueryAdmission(ctx context.Context) error {
	if admitted, marked := ctx.Value(dashboardQueryAdmissionKey{}).(bool); marked && !admitted {
		return connect.NewError(connect.CodeResourceExhausted, errors.New("dashboard query requires bounded orchestration admission; reduce the MCP request envelope"))
	}
	return nil
}

const dashboardQueryInputSchema = `{"type":"object","additionalProperties":false,"required":["id"],"properties":{
"id":` + insightsIDSchema + `,
"variables":{"type":"object","maxProperties":20,"additionalProperties":{"type":"string","maxLength":1024},"description":"Overrides declared dashboard variables for this read only; saved defaults are unchanged."},
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
"dashboard":{"type":"object","required":["id","title","etag"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"etag":{"type":"string"}}},
"observedAt":{"type":"string","format":"date-time"},
"range":{"type":"object","required":["start","end","stepSeconds"],"properties":{"start":{"type":"string","format":"date-time"},"end":{"type":"string","format":"date-time"},"stepSeconds":{"type":"number"}}},
"variables":{"type":"object","additionalProperties":{"type":"string"}},
"widgets":{"type":"array","items":{"type":"object","required":["id","title","type","unit"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"type":{"type":"string"},"pluginId":{"type":"string","description":"Registered visualization ID when type is plugin; configuration remains in the saved dashboard document."},"dataKind":{"enum":["metrics","records","traces"],"description":"Normalized input kind for a plugin visualization."},"savedQueryId":{"type":"string","description":"Saved query referenced by this widget, including failed resolution; see savedQueries for its captured ETag when available."},"annotationSavedQueryId":{"type":"string","description":"Saved query referenced by the widget annotation source, including failed resolution."},"unit":{"type":"string"},"decimals":{"type":"integer"},"signalId":{"type":"string"},"error":{"$ref":"#/$defs/error"},"freshness":{"type":"object","description":"Age of the primary series' latest valid returned sample relative to the selected range end. This is not underlying scrape or ingestion health. Unknown means no usable returned sample.","required":["thresholdSeconds","state"],"properties":{"thresholdSeconds":{"type":"integer"},"state":{"enum":["fresh","stale","unknown"]},"lastTimestamp":{"type":"number","description":"Unix milliseconds"},"ageSeconds":{"type":"number"}}},"threshold":{"type":"object","additionalProperties":false,"description":"A configured Single value visual band for the last valid displayed sample, not an alert or service-health verdict. The first band also applies below its boundary; an authored text color may override the displayed text. A missing latest observation is reported separately on the signal.","required":["state"],"properties":{"state":{"enum":["matched","unknown"]},"boundary":{"type":"number"},"color":{"type":"string"},"label":{"type":"string"}},"oneOf":[{"properties":{"state":{"const":"matched"}},"required":["boundary","color"]},{"properties":{"state":{"const":"unknown"}},"not":{"anyOf":[{"required":["boundary"]},{"required":["color"]},{"required":["label"]}]}}]},"annotationSignalId":{"type":"string"},"annotationError":{"$ref":"#/$defs/error"},"annotationColumns":{"type":"object","required":["timestamp","label"],"properties":{"timestamp":{"type":"string"},"end":{"type":"string","description":"Optional end-time column for interval annotations."},"label":{"type":"string"},"severity":{"type":"string"}}}}}},
"savedQueries":{"type":"array","items":{"type":"object","required":["id","etag"],"properties":{"id":{"type":"string"},"etag":{"type":"string"}}}},
"signals":{"type":"array","items":{"type":"object","required":["id","state"],"properties":{
"id":{"type":"string"},"kind":{"enum":["metrics","records","traces"],"description":"Normalized query kind, including empty and failed results."},"providerId":{"type":"string","description":"Resolved provider ID when the caller is authorized to resolve the provider; omitted when its lookup fails."},"state":{"enum":["ok","partial","empty","error"],"description":"Data availability, not health. A source-limited response without usable observations is partial rather than definitively empty; populated limited responses remain ok and disclose providerTruncated."},"error":{"$ref":"#/$defs/error"},"primarySeries":{"type":"integer"},
"truncated":{"type":"boolean","description":"Some data was omitted from this bounded signal or its compact summary; check providerTruncated and the specific preview flags to distinguish source limits from presentation limits."},"providerTruncated":{"type":"boolean","description":"The provider response hit a source limit or was otherwise partial. State can still be ok when a bounded query succeeded; do not treat returned counts as source-wide totals."},"seriesTruncated":{"type":"boolean","description":"The compact output omitted fetched series; distinct from providerTruncated."},"seriesReturned":{"type":"integer","minimum":0,"description":"Series in the bounded provider response, not source-wide cardinality. Present for successful metric queries, including zero."},"seriesOmitted":{"type":"integer","minimum":0,"description":"Fetched series omitted from the compact summary; independent of source limits disclosed by providerTruncated."},
"series":{"type":"array","items":{"$ref":"#/$defs/series"}},"records":{"$ref":"#/$defs/records"},
"traces":{"type":"object","required":["returned","statusCounts"],"properties":{"returned":{"type":"integer"},"statusCounts":{"type":"object","additionalProperties":{"type":"integer"}},"examplesTruncated":{"type":"boolean"},"metadataTruncated":{"type":"boolean"},"examples":{"type":"array","items":{"type":"object","required":["traceId","status"],"properties":{"traceId":{"type":"string"},"service":{"type":"string"},"operation":{"type":"string"},"durationMs":{"type":"number","description":"Trace duration in milliseconds."},"startTime":{"type":"number","description":"Trace start as Unix milliseconds."},"status":{"type":"string"},"invalidFields":{"type":"boolean"}}}}}}
}}},
"queryCount":{"type":"object","required":["planned","executed","deduplicated"],"properties":{"planned":{"type":"integer"},"executed":{"type":"integer"},"deduplicated":{"type":"integer"}}},
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
		Description: "Execute a saved dashboard with its live saved queries and optional variable overrides. Returns compact, versioned machine-readable signals: exact latest values, unweighted means of returned finite samples, bounded range summaries, trace samples and record previews, plus document versions and missing/error/truncation states. Compact text includes the execution range, bounded selected variables, widget and provider errors, configured Single value visual bands and bounded per-series observations for multi-series signals, with omissions disclosed; structured content remains authoritative and may contain more detail. Sample means include duplicate timestamps and are not time weighted or source-wide. Visual bands describe author-configured thresholds, not alert or service health. Record previews include at most 3 rows and 12 columns; returned counts describe the fetched page, never a source-wide total. Identical queries execute once. No layout, query expressions or raw metric sample arrays by default. State describes data availability, not service health. Read-only; requires paprika:observe and human Insights read permission, not authoring consent.",
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
		ID            string            `json:"id"`
		Variables     map[string]string `json:"variables,omitempty"`
		WidgetIDs     []string          `json:"widget_ids,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
		Start         string            `json:"start,omitempty"`
		End           string            `json:"end,omitempty"`
		HistoryPoints *int              `json:"history_points,omitempty"` //nolint:tagliatelle // MCP arguments use snake_case.
		MaxSeries     *int              `json:"max_series,omitempty"`     //nolint:tagliatelle // MCP arguments use snake_case.
		MaxTraces     *int              `json:"max_traces,omitempty"`     //nolint:tagliatelle // MCP arguments use snake_case.
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
	ID                string                `json:"id"`
	Kind              string                `json:"kind"`
	ProviderID        string                `json:"providerId"`
	State             string                `json:"state"`
	Error             *dashboardTextError   `json:"error"`
	PrimarySeries     *int                  `json:"primarySeries"`
	Series            []dashboardTextSeries `json:"series"`
	Records           *dashboardTextRecords `json:"records"`
	Truncated         bool                  `json:"truncated"`
	ProviderTruncated bool                  `json:"providerTruncated"`
	SeriesTruncated   bool                  `json:"seriesTruncated"`
	SeriesReturned    *int                  `json:"seriesReturned"`
	SeriesOmitted     *int                  `json:"seriesOmitted"`
	Traces            *dashboardTextTraces  `json:"traces"`
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
		Key string `json:"key"`
	} `json:"columns"`
	Rows [][]json.RawMessage `json:"rows"`
}

type dashboardTextWidget struct {
	ID                 string              `json:"id"`
	Title              string              `json:"title"`
	Type               string              `json:"type"`
	PluginID           string              `json:"pluginId"`
	Unit               string              `json:"unit"`
	SignalID           string              `json:"signalId"`
	AnnotationSignalID string              `json:"annotationSignalId"`
	Error              *dashboardTextError `json:"error"`
	AnnotationError    *dashboardTextError `json:"annotationError"`
	Freshness          *struct {
		State            string   `json:"state"`
		ThresholdSeconds int      `json:"thresholdSeconds"`
		AgeSeconds       *float64 `json:"ageSeconds"`
	} `json:"freshness"`
	Threshold *struct {
		State    string   `json:"state"`
		Boundary *float64 `json:"boundary"`
		Color    string   `json:"color"`
		Label    string   `json:"label"`
	} `json:"threshold"`
}

type dashboardTextSummary struct {
	SchemaVersion int `json:"schemaVersion"`
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
	Variables map[string]string     `json:"variables"`
	State     string                `json:"state"`
	Widgets   []dashboardTextWidget `json:"widgets"`
	Signals   []dashboardTextSignal `json:"signals"`
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
	appendDashboardHeaderText(&out, &summary)
	if summary.Variables != nil {
		appendDashboardVariablesText(&out, summary.Variables)
	}
	// A widget can fail before it has a signal (for example, a missing saved
	// query). Report these first so a text-only client does not miss the error.
	if appendDashboardWidgetDiagnostics(&out, summary.Widgets) {
		return out.String(), nil
	}
	appendDashboardThresholdsText(&out, summary.Widgets)
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
		if widget.Freshness != nil {
			line := fmt.Sprintf("widget %s: returned sample freshness=%s (threshold %ds", strconv.Quote(shortDashboardText(widget.ID, 80)), widget.Freshness.State, widget.Freshness.ThresholdSeconds)
			if widget.Freshness.AgeSeconds != nil {
				line += fmt.Sprintf(", age %.0fs", *widget.Freshness.AgeSeconds)
			}
			line += "); relative to range end, not scrape health\n"
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
		if widget.Threshold.State == "matched" && widget.Threshold.Boundary != nil {
			fmt.Fprintf(&line, "; boundary=%s; color=%s", strconv.FormatFloat(*widget.Threshold.Boundary, 'g', -1, 64), strconv.Quote(shortDashboardText(widget.Threshold.Color, 16)))
			if widget.Threshold.Label != "" {
				fmt.Fprintf(&line, "; label=%s", strconv.Quote(shortDashboardText(widget.Threshold.Label, 80)))
			}
		}
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
func appendDashboardVariablesText(out *strings.Builder, variables map[string]string) {
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
		item := fmt.Sprintf(" %s=%s", strconv.Quote(shortDashboardText(key, 48)), strconv.Quote(shortDashboardText(variables[key], 96)))
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

func dashboardSignalIdentity(signalID string, widgets []dashboardTextWidget) (title, unit, view string, matched int) {
	title = signalID
	for index := range widgets {
		widget := &widgets[index]
		if widget.SignalID == signalID {
			matched++
			if matched == 1 {
				title, unit, view = widget.Title, widget.Unit, widget.Type
				if widget.Type == "plugin" && widget.PluginID != "" {
					view = widget.PluginID
				}
			}
		}
	}
	if title == signalID {
		title = dashboardAnnotationTitle(signalID, title, widgets)
	}
	return title, unit, view, matched
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
	title, unit, view, matched := dashboardSignalIdentity(signal.ID, widgets)
	var line strings.Builder
	fmt.Fprintf(&line, "%s %s: %s", signal.ID, strconv.Quote(shortDashboardText(title, 160)), signal.State)
	if view != "" {
		fmt.Fprintf(&line, "; first view=%s", strconv.Quote(shortDashboardText(view, 80)))
		if matched > 1 {
			fmt.Fprintf(&line, "; shared widgets=%d", matched)
		}
	}
	appendDashboardSignalMetadata(&line, signal)
	appendDashboardPrimaryText(&line, signal, unit)
	appendDashboardSignalSeries(&line, signal, unit)
	if signal.Traces != nil {
		fmt.Fprintf(&line, "; returned traces=%d (bounded sample)", signal.Traces.Returned)
		if signal.Traces.ExamplesTruncated || signal.Traces.MetadataTruncated {
			line.WriteString("; trace preview truncated")
		}
		appendDashboardTraceText(&line, signal.Traces)
	}
	appendDashboardRecordText(&line, signal.Records, signal.ProviderTruncated)
	appendDashboardTruncationText(&line, signal)
	return line.String()
}

func appendDashboardTruncationText(line *strings.Builder, signal *dashboardTextSignal) {
	if signal.Records == nil && signal.ProviderTruncated {
		line.WriteString("; partial source response")
	}
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

func appendDashboardPrimaryText(line *strings.Builder, signal *dashboardTextSignal, unit string) {
	if signal.PrimarySeries == nil {
		return
	}
	for index := range signal.Series {
		series := &signal.Series[index]
		if series.Index != *signal.PrimarySeries || series.Last == nil {
			continue
		}
		fmt.Fprintf(line, "; latest valid=%s %s at %s ms", strconv.FormatFloat(series.Last.Value, 'g', -1, 64), strconv.Quote(shortDashboardText(unit, 48)), strconv.FormatFloat(series.Last.Timestamp, 'f', -1, 64))
		if series.Mean != nil {
			fmt.Fprintf(line, "; sample mean=%s %s", strconv.FormatFloat(*series.Mean, 'g', -1, 64), strconv.Quote(shortDashboardText(unit, 48)))
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
	if signal.SeriesReturned != nil && signal.SeriesOmitted != nil {
		fmt.Fprintf(line, "; returned series=%d (bounded response), omitted summaries=%d", *signal.SeriesReturned, *signal.SeriesOmitted)
	}
	if signal.Error != nil {
		fmt.Fprintf(line, "; error %s: %s", strconv.Quote(shortDashboardText(signal.Error.Code, 80)), strconv.Quote(shortDashboardText(signal.Error.Message, 240)))
	}
}

func appendDashboardSignalSeries(line *strings.Builder, signal *dashboardTextSignal, unit string) {
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
		appendDashboardSeriesText(line, signal.Series, unit)
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
			fmt.Fprintf(&item, " duration=%s ms", strconv.FormatFloat(*example.DurationMs, 'g', -1, 64))
		}
		if example.StartTime != nil {
			fmt.Fprintf(&item, " start=%s ms", strconv.FormatFloat(*example.StartTime, 'f', -1, 64))
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

func appendDashboardSeriesText(line *strings.Builder, entries []dashboardTextSeries, unit string) {
	var synopsis strings.Builder
	shown := 0
	for index := range entries {
		item := dashboardSeriesItemText(&entries[index], unit)
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

func dashboardSeriesItemText(entry *dashboardTextSeries, unit string) string {
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
		fmt.Fprintf(&item, "; last valid=%s %s at %s ms", strconv.FormatFloat(entry.Last.Value, 'g', -1, 64), strconv.Quote(shortDashboardText(unit, 48)), strconv.FormatFloat(entry.Last.Timestamp, 'f', -1, 64))
	}
	if entry.Mean != nil {
		fmt.Fprintf(&item, "; sample mean=%s %s", strconv.FormatFloat(*entry.Mean, 'g', -1, 64), strconv.Quote(shortDashboardText(unit, 48)))
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

func appendDashboardRecordText(line *strings.Builder, records *dashboardTextRecords, providerTruncated bool) {
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
		line.WriteString("; partial source response")
	}
	appendDashboardRecordPreview(line, records)
}

func appendDashboardRecordPreview(line *strings.Builder, records *dashboardTextRecords) {
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
		fmt.Fprintf(line, "%s=%s", strconv.Quote(shortDashboardText(records.Columns[index].Key, 48)), dashboardRecordScalarText(row[index]))
	}
}

func dashboardRecordScalarText(raw json.RawMessage) string {
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
		return shortDashboardText(value.String(), 80)
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
