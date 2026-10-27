package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
"widgets":{"type":"array","items":{"type":"object","required":["id","title","type","unit"],"properties":{"id":{"type":"string"},"title":{"type":"string"},"type":{"type":"string"},"unit":{"type":"string"},"decimals":{"type":"integer"},"signalId":{"type":"string"},"error":{"$ref":"#/$defs/error"}}}},
"savedQueries":{"type":"array","items":{"type":"object","required":["id","etag"],"properties":{"id":{"type":"string"},"etag":{"type":"string"}}}},
"signals":{"type":"array","items":{"type":"object","required":["id","state"],"properties":{
"id":{"type":"string"},"state":{"enum":["ok","partial","empty","error"]},"error":{"$ref":"#/$defs/error"},"primarySeries":{"type":"integer"},
"truncated":{"type":"boolean"},"providerTruncated":{"type":"boolean"},"seriesTruncated":{"type":"boolean"},
"series":{"type":"array","items":{"$ref":"#/$defs/series"}},"records":{"$ref":"#/$defs/records"},
"traces":{"type":"object","required":["returned","statusCounts"],"properties":{"returned":{"type":"integer"},"statusCounts":{"type":"object","additionalProperties":{"type":"integer"}},"examplesTruncated":{"type":"boolean"},"metadataTruncated":{"type":"boolean"},"examples":{"type":"array","items":{"type":"object","required":["traceId","status"],"properties":{"traceId":{"type":"string"},"service":{"type":"string"},"operation":{"type":"string"},"durationMs":{"type":"number"},"startTime":{"type":"number"},"status":{"type":"string"},"invalidFields":{"type":"boolean"}}}}}}
}}},
"queryCount":{"type":"object","required":["planned","executed","deduplicated"],"properties":{"planned":{"type":"integer"},"executed":{"type":"integer"},"deduplicated":{"type":"integer"}}},
"state":{"enum":["ok","partial","empty"]}
},"$defs":{
"error":{"type":"object","required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}},
"sample":{"type":"object","required":["timestamp","value"],"properties":{"timestamp":{"type":"number"},"value":{"type":"number"}}},
"recordColumn":{"type":"object","additionalProperties":false,"required":["key","type"],"properties":{"key":{"type":"string","minLength":1,"maxLength":128},"label":{"type":"string","maxLength":256},"type":{"enum":["string","number","boolean","timestamp"]},"unit":{"type":"string","maxLength":24}}},
"records":{"type":"object","additionalProperties":false,"required":["returned","columns","rows"],"properties":{"returned":{"type":"integer","minimum":0,"maximum":1000,"description":"Rows in the fetched provider page, not a source-wide total."},"columns":{"type":"array","minItems":1,"maxItems":12,"items":{"$ref":"#/$defs/recordColumn"}},"rows":{"type":"array","maxItems":3,"items":{"type":"array","minItems":1,"maxItems":12,"items":{"type":["string","number","boolean","null"]}},"description":"Preview tuples in column order; null remains missing and zero remains zero."},"rowsTruncated":{"type":"boolean"},"columnsOmitted":{"type":"integer","minimum":0,"maximum":52},"metadataTruncated":{"type":"boolean"}}},
"series":{"type":"object","required":["index","samples","valid","missing"],"properties":{"index":{"type":"integer"},"name":{"type":"string"},"labels":{"type":"object","additionalProperties":{"type":"string"}},"samples":{"type":"integer"},"valid":{"type":"integer"},"missing":{"type":"integer"},"invalidTimestamps":{"type":"integer"},"first":{"$ref":"#/$defs/sample"},"last":{"$ref":"#/$defs/sample"},"min":{"type":"number"},"max":{"type":"number"},"firstAt":{"type":"number"},"lastAt":{"type":"number"},"tailMissing":{"type":"boolean"},"metadataTruncated":{"type":"boolean"},"labelsOmitted":{"type":"integer"},"historyTruncated":{"type":"boolean"},"history":{"type":"array","items":{"type":"array","minItems":2,"maxItems":2,"prefixItems":[{"type":"number"},{"type":["number","null"]}]}}}}
}}`

func insightsQueryDashboardTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{
		Name: "query_dashboard", Title: "Read dashboard signals", Scope: mcp.ScopeObserve,
		Description: "Execute a saved dashboard with its live saved queries and optional variable overrides. Returns compact, versioned machine-readable signals: exact latest values, bounded range summaries, trace samples and record previews, plus document versions and missing/error/truncation states. Record previews include at most 3 rows and 12 columns; returned counts describe the fetched page, never a source-wide total. Identical queries execute once. No layout, query expressions or raw metric sample arrays by default. State describes data availability, not service health. Read-only; requires paprika:observe and human Insights read permission, not authoring consent.",
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
	Value float64 `json:"value"`
}

type dashboardTextSeries struct {
	Index int                  `json:"index"`
	Last  *dashboardTextSample `json:"last"`
}

type dashboardTextSignal struct {
	ID                string                `json:"id"`
	State             string                `json:"state"`
	PrimarySeries     *int                  `json:"primarySeries"`
	Series            []dashboardTextSeries `json:"series"`
	Records           *dashboardTextRecords `json:"records"`
	ProviderTruncated bool                  `json:"providerTruncated"`
	Traces            *struct {
		Returned int `json:"returned"`
	} `json:"traces"`
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
	ID       string `json:"id"`
	Title    string `json:"title"`
	Unit     string `json:"unit"`
	SignalID string `json:"signalId"`
}

func dashboardQueryText(raw json.RawMessage) (string, error) {
	var summary struct {
		SchemaVersion int `json:"schemaVersion"`
		Dashboard     struct {
			ID string `json:"id"`
		} `json:"dashboard"`
		State   string                `json:"state"`
		Widgets []dashboardTextWidget `json:"widgets"`
		Signals []dashboardTextSignal `json:"signals"`
	}
	if err := json.Unmarshal(raw, &summary); err != nil {
		return "", fmt.Errorf("decode dashboard summary: %w", err)
	}
	if summary.SchemaVersion != 1 || summary.Dashboard.ID == "" || summary.Signals == nil || summary.Widgets == nil {
		return "", errors.New("missing dashboard summary fields")
	}
	var out strings.Builder
	fmt.Fprintf(&out, "Dashboard %s: %s. Structured content is authoritative; state is data availability, not health.\n", strconv.Quote(summary.Dashboard.ID), summary.State)
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

func dashboardSignalText(signal *dashboardTextSignal, widgets []dashboardTextWidget) string {
	title, unit := signal.ID, ""
	for _, widget := range widgets {
		if widget.SignalID == signal.ID {
			title, unit = widget.Title, widget.Unit
			break
		}
	}
	var line strings.Builder
	fmt.Fprintf(&line, "%s %s: %s", signal.ID, strconv.Quote(shortDashboardText(title, 160)), signal.State)
	if signal.PrimarySeries != nil {
		for _, series := range signal.Series {
			if series.Index == *signal.PrimarySeries && series.Last != nil {
				fmt.Fprintf(&line, "; latest=%s %s", strconv.FormatFloat(series.Last.Value, 'g', -1, 64), strconv.Quote(shortDashboardText(unit, 48)))
				break
			}
		}
	}
	if len(signal.Series) != 0 {
		fmt.Fprintf(&line, "; series=%d", len(signal.Series))
	}
	if signal.Traces != nil {
		fmt.Fprintf(&line, "; returned traces=%d (bounded sample)", signal.Traces.Returned)
	}
	appendDashboardRecordText(&line, signal.Records, signal.ProviderTruncated)
	return line.String()
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
