package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// defaultQueryWindow is the lookback the query tools assume when a caller
// passes start without end (end defaults to now): the trailing thirty
// minutes, wide enough to be useful and narrow enough to keep backend
// responses small.
const defaultQueryWindow = 30 * time.Minute

// textPreviewMaxBytes caps the TextContent rendering of a query tool
// result; the full payload always travels in structuredContent (see
// mcp.PreviewToolResult).
const textPreviewMaxBytes = 16 << 10

// providerToolPreview preserves the provider's structured verdict and data,
// while ensuring MCP clients also see a failed tool outcome for non-OK states.
// Warnings accompanying an OK result describe partial data, not a failed call.
func providerToolPreview(value any, state connector.State) (*sdkmcp.CallToolResult, error) {
	result, err := mcp.PreviewToolResult(value, textPreviewMaxBytes)
	if err != nil {
		return nil, fmt.Errorf("render observability provider result: %w", err)
	}
	result.IsError = state != connector.StateOK
	return result, nil
}

// RegisterTools registers the observability gateway's thirteen MCP tools on
// registry. Every tool is read-only and carries ScopeObserve: querying logs,
// metrics and traces — browsing the provider catalog, exploring backend
// schema, and validating prospective configurations — never mutates the
// fleet or the backends behind the providers.
//
// The Invoke closures capture b and ignore the v1connect client parameter:
// these tools close over the observability backend, not the fleet Connect
// API that client speaks — the client exists for the console read/write
// tools (see internal/api/mcp/tools_read.go). The catalog tools close over
// the catalog metadata alone.
//
// When usage is non-nil every tool's Invoke is wrapped so its outcome is
// recorded in the tracker; a nil tracker disables recording without the
// wrappers existing at all, so the disabled configuration adds no work per
// call.
func RegisterTools(registry *mcp.Registry, b Backend, usage *UsageTracker) error {
	tools := []mcp.Tool{
		listObservabilityProvidersTool(b),
		getObservabilityProviderTool(b),
		queryMetricsTool(b),
		queryLogsTool(b),
		queryTracesTool(b),
		listProviderTypesTool(),
		describeProviderTypeTool(),
		validateProviderTool(),
		listMetricNamesTool(b),
		listLabelNamesTool(b),
		listLabelValuesTool(b),
		getMetricMetadataTool(b),
		listTraceServicesTool(b),
	}
	for i := range tools {
		if usage != nil {
			tools[i].Invoke = recordUsage(usage, tools[i].Name, tools[i].Invoke)
		}
		if err := registry.Register(tools[i]); err != nil {
			return fmt.Errorf("register observability tools: %w", err)
		}
	}
	return nil
}

// toolArgs is a decoded tool-call argument object, mirroring the
// decodeArgs convention in internal/api/mcp: the wire protocol's field names
// are snake_case by MCP convention, which this repo's tagliatelle
// configuration (camelCase json tags) would otherwise flag on every struct
// field. Local copy because mcp's helper is unexported.
type toolArgs map[string]any

// decodeArgs parses a tool call's raw arguments. Absent or literal-null
// arguments decode to an empty toolArgs rather than erroring, since every
// field has a documented default.
func decodeArgs(raw json.RawMessage) (toolArgs, error) {
	if len(raw) == 0 {
		return toolArgs{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode arguments: %w", err)
	}
	if m == nil {
		m = map[string]any{}
	}
	if err := validateToolLimit(toolArgs(m)); err != nil {
		return nil, err
	}
	if err := validateToolPageToken(toolArgs(m)); err != nil {
		return nil, err
	}

	return toolArgs(m), nil
}

func validateToolLimit(in toolArgs) error {
	rawLimit, present := in["limit"]
	if !present {
		return nil
	}
	limit, ok := rawLimit.(float64)
	if !ok || math.Trunc(limit) != limit || limit < 1 || limit > maxQueryResults {
		return errors.New("limit must be an integer between 1 and 1000")
	}
	return nil
}

func validateToolPageToken(in toolArgs) error {
	rawToken, present := in["page_token"]
	if !present {
		return nil
	}
	token, ok := rawToken.(string)
	if !ok || len(token) > connector.MaxPageTokenBytes {
		return errors.New("page_token must be a string of at most 4096 bytes")
	}
	if token != "" && (in.string("start") == "" || in.string("end") == "") {
		return errors.New("page_token requires explicit start and end matching the original query")
	}
	return nil
}

func (a toolArgs) string(key string) string {
	if s, ok := a[key].(string); ok {
		return s
	}
	return ""
}

// int reads a JSON number field. JSON numbers decode to float64 in a
// map[string]any, so absent or non-numeric values read as 0 and are left to
// the caller's own defaulting logic.
func (a toolArgs) int(key string) int {
	f, ok := a[key].(float64)
	if !ok {
		return 0
	}
	return int(f)
}

// requiredString reads an argument that must be present and non-empty.
func requiredString(in toolArgs, tool, key string) (string, error) {
	s := in.string(key)
	if s == "" {
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s: %s is required", tool, key))
	}
	return s, nil
}

// parseTimeArg reads one optional RFC3339 timestamp argument.
func parseTimeArg(in toolArgs, key string) (time.Time, error) {
	if value, present := in[key]; present {
		if _, ok := value.(string); !ok {
			return time.Time{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s must be an RFC3339 timestamp", key))
		}
	}
	raw := in.string(key)
	if raw == "" {
		return time.Time{}, nil
	}
	ts, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return time.Time{}, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("%s must be an RFC3339 timestamp, got %q", key, raw))
	}
	return ts, nil
}

// queryWindow resolves the optional start/end pair onto an absolute range:
// end defaults to now, start defaults to end minus the trailing window.
func queryWindow(in toolArgs) (connector.TimeRange, error) {
	end, err := parseTimeArg(in, "end")
	if err != nil {
		return connector.TimeRange{}, err
	}
	start, err := parseTimeArg(in, "start")
	if err != nil {
		return connector.TimeRange{}, err
	}
	if end.IsZero() {
		end = time.Now().UTC()
	}
	if start.IsZero() {
		start = end.Add(-defaultQueryWindow)
	}
	window := connector.TimeRange{Start: start, End: end}
	return window, validateWindow(window)
}

// limitArg reads an optional result limit, defaulting an absent or
// non-positive value to def — the same "0 means unset" reading the console
// tools apply to page sizes.
func limitArg(in toolArgs, def int) int {
	if n := in.int("limit"); n > 0 {
		return n
	}
	return def
}

// observedAt stamps a tool response with the UTC instant it was produced, so
// a caller paging through results can tell when each snapshot was taken.
func observedAt() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// providerDetail is the get_observability_provider response: the provider's
// public summary plus the signals its connector advertises.
type providerDetail struct {
	ProviderInfo
	Signals    []string `json:"signals"`
	Supported  bool     `json:"supported"`
	ObservedAt string   `json:"observedAt"`
}

// describeProvider builds the detail for one provider. A type New does not
// know is reported as supported=false rather than an error — the CR still
// exists and its status fields carry whatever the controllers last observed.
func describeProvider(info *ProviderInfo) providerDetail {
	detail := providerDetail{
		ProviderInfo: *info,
		Signals:      []string{},
		ObservedAt:   observedAt(),
	}
	conn, err := New(info.Type)
	if err != nil {
		return detail
	}
	detail.Supported = true
	for _, s := range conn.Descriptor().Signals {
		detail.Signals = append(detail.Signals, string(s))
	}
	return detail
}

// queryToolResult is the wire shape every query_* tool returns: which
// provider answered, which signal was asked, the connector's state verdict
// with its fixed-sentence reason, and the backend's JSON passed through
// untouched.
type queryToolResult struct {
	Provider   string          `json:"provider"`
	Signal     string          `json:"signal"`
	State      connector.State `json:"state"`
	Reason     string          `json:"reason,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
	ObservedAt string          `json:"observedAt"`
}

func queryToolResponse(provider, signalLabel string, result *connector.QueryResult) queryToolResult {
	return queryToolResult{
		Provider:   provider,
		Signal:     signalLabel,
		State:      result.State,
		Reason:     result.Reason,
		Data:       result.Data,
		ObservedAt: observedAt(),
	}
}

func listObservabilityProvidersTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_observability_providers",
		Description: "List the observability providers (Prometheus, Loki, Tempo, OTLP, Google Cloud Logging/Monitoring/Trace, AWS CloudWatch Logs/Metrics, X-Ray, CloudTrail, Vultr Monitoring, mock) configured in this cluster and visible to this gateway, with each provider's current state.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
			providers, err := b.ListProviders(ctx)
			if err != nil {
				return nil, fmt.Errorf("list_observability_providers: %w", err)
			}
			return map[string]any{
				"providers":  providers,
				"observedAt": observedAt(),
			}, nil
		},
	}
}

func getObservabilityProviderTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "get_observability_provider",
		Description: "Describe one observability provider by \"namespace/name\": its type, current state, and which signals (logs, metrics, traces) its connector can serve.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{"provider":{"type":"string"}},
			"required":["provider"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "get_observability_provider", "provider")
			if err != nil {
				return nil, err
			}
			infos, err := b.ListProviders(ctx)
			if err != nil {
				return nil, fmt.Errorf("get_observability_provider: %w", err)
			}
			for i := range infos {
				if infos[i].Name == provider {
					return describeProvider(&infos[i]), nil
				}
			}
			return nil, connect.NewError(connect.CodeNotFound,
				fmt.Errorf("observability provider %q not found", provider))
		},
	}
}

func queryMetricsTool(b Backend) mcp.Tool {
	return nativeQueryTool(b, connector.SignalMetrics)
}

func queryLogsTool(b Backend) mcp.Tool {
	return nativeQueryTool(b, connector.SignalLogs)
}

// Metrics and logs share the same bounded query contract; only the native
// signal selects the connector's query language and response label.
func nativeQueryTool(b Backend, signal connector.Signal) mcp.Tool {
	name := "query_" + string(signal)
	return mcp.Tool{
		Name:        name,
		Description: fmt.Sprintf("Run a %s query in the configured provider's native query language. Read-only; start and end default to the trailing thirty minutes, with a maximum window of 24 hours. Limit defaults to 100 (maximum 1000).", signal),
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"query":{"type":"string"},
				"start":{"type":"string"},
				"end":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100},
				"page_token":{"type":"string","maxLength":4096,"description":"GCP continuation token; resend the original query, start, end and limit unchanged"}
			},
			"required":["provider","query"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, name, "provider")
			if err != nil {
				return nil, err
			}
			query, err := requiredString(in, name, "query")
			if err != nil {
				return nil, err
			}
			window, err := queryWindow(in)
			if err != nil {
				return nil, err
			}
			result, err := b.Query(ctx, provider, connector.QueryRequest{
				Signal:    signal,
				Query:     query,
				Range:     window,
				Limit:     limitArg(in, 100),
				PageToken: in.string("page_token"),
			})
			if err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			return providerToolPreview(queryToolResponse(provider, string(signal), result), result.State)
		},
	}
}

func queryTracesTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "query_traces",
		Description: "Query traces in the configured provider's native query language or by trace ID (at least one of query or trace_id is required). Read-only; start and end default to the trailing thirty minutes, with a maximum window of 24 hours. Limit defaults to 100 (maximum 1000).",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"query":{"type":"string"},
				"trace_id":{"type":"string"},
				"start":{"type":"string"},
				"end":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100},
				"page_token":{"type":"string","maxLength":4096,"description":"GCP continuation token; resend the original query, start, end and limit unchanged"}
			},
			"required":["provider"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "query_traces", "provider")
			if err != nil {
				return nil, err
			}
			query := in.string("query")
			traceID := in.string("trace_id")
			if query == "" && traceID == "" {
				return nil, connect.NewError(connect.CodeInvalidArgument,
					errors.New("query_traces: one of query or trace_id is required"))
			}
			window, err := queryWindow(in)
			if err != nil {
				return nil, err
			}
			result, err := b.Query(ctx, provider, connector.QueryRequest{
				Signal:    connector.SignalTraces,
				Query:     query,
				TraceID:   traceID,
				Range:     window,
				Limit:     limitArg(in, 100),
				PageToken: in.string("page_token"),
			})
			if err != nil {
				return nil, fmt.Errorf("query_traces: %w", err)
			}
			return providerToolPreview(queryToolResponse(provider, "traces", result), result.State)
		},
	}
}

// exploreToolResult is the wire shape every exploration tool returns: which
// provider answered, which schema slice was asked for, the state verdict
// with its fixed-sentence reason, and the backend's JSON passed through
// untouched. Kinds map onto connector.ExploreKind values.
type exploreToolResult struct {
	Provider   string          `json:"provider"`
	Kind       string          `json:"kind"`
	State      connector.State `json:"state"`
	Reason     string          `json:"reason,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
	ObservedAt string          `json:"observedAt"`
}

func exploreToolResponse(provider string, kind connector.ExploreKind, result *connector.ExploreResult) exploreToolResult {
	return exploreToolResult{
		Provider:   provider,
		Kind:       string(kind),
		State:      result.State,
		Reason:     result.Reason,
		Data:       result.Data,
		ObservedAt: observedAt(),
	}
}

func listMetricNamesTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_metric_names",
		Description: "List metric names before writing a query. Optional prefix filters to names containing the substring; limit defaults to 100 (maximum 1000). The optional namespace scopes AWS CloudWatch metrics enumeration; other provider types ignore it.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"prefix":{"type":"string"},
				"namespace":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "list_metric_names", "provider")
			if err != nil {
				return nil, err
			}
			result, err := b.Explore(ctx, provider, connector.ExploreRequest{
				Kind:   connector.ExploreMetricNames,
				Prefix: in.string("prefix"),
				Limit:  limitArg(in, 100),
				Params: exploreParams(in),
			})
			if err != nil {
				return nil, fmt.Errorf("list_metric_names: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreMetricNames, result), result.State)
		},
	}
}

// exploreParams builds the optional provider-specific filter map from the
// tool arguments. Only keys a provider type documents are forwarded; today
// that is "namespace" for AWS CloudWatch metrics.
func exploreParams(in toolArgs) map[string]string {
	if ns := in.string("namespace"); ns != "" {
		return map[string]string{"namespace": ns}
	}
	return nil
}

func listLabelNamesTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_label_names",
		Description: "List the label names a provider exposes — Prometheus labels globally or on one metric; Loki stream labels; Tempo search tags; AWS CloudWatch metric dimension names; Google Cloud Monitoring descriptor label keys. The optional namespace scopes CloudWatch dimension enumeration; other provider types ignore it.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"metric":{"type":"string"},
				"namespace":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "list_label_names", "provider")
			if err != nil {
				return nil, err
			}
			result, err := b.Explore(ctx, provider, connector.ExploreRequest{
				Kind:   connector.ExploreLabelNames,
				Limit:  limitArg(in, 100),
				Metric: in.string("metric"),
				Params: exploreParams(in),
			})
			if err != nil {
				return nil, fmt.Errorf("list_label_names: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreLabelNames, result), result.State)
		},
	}
}

func listLabelValuesTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_label_values",
		Description: "List the values one label takes on a provider — a Prometheus or Loki label globally, or constrained to one metric when metric is set (Prometheus); a Tempo search tag's values; an AWS CloudWatch metric dimension's values. The optional namespace scopes CloudWatch dimension enumeration; other provider types ignore it. Note Google Cloud Monitoring descriptor label values are not enumerable (keys only) and answer NotAvailable.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"label":{"type":"string"},
				"metric":{"type":"string"},
				"namespace":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider","label"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "list_label_values", "provider")
			if err != nil {
				return nil, err
			}
			label, err := requiredString(in, "list_label_values", "label")
			if err != nil {
				return nil, err
			}
			result, err := b.Explore(ctx, provider, connector.ExploreRequest{
				Kind:   connector.ExploreLabelValues,
				Limit:  limitArg(in, 100),
				Label:  label,
				Metric: in.string("metric"),
				Params: exploreParams(in),
			})
			if err != nil {
				return nil, fmt.Errorf("list_label_values: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreLabelValues, result), result.State)
		},
	}
}

func getMetricMetadataTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "get_metric_metadata",
		Description: "Describe one metric on a metrics provider (Prometheus-compatible APIs and Google Cloud Monitoring): its type (counter, gauge, histogram, summary / metricKind + valueType), help text or description, and unit, as the backend's metadata API reports it. Use it to write a correct query — rate() a counter, read a gauge directly.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"metric":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider","metric"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "get_metric_metadata", "provider")
			if err != nil {
				return nil, err
			}
			metric, err := requiredString(in, "get_metric_metadata", "metric")
			if err != nil {
				return nil, err
			}
			result, err := b.Explore(ctx, provider, connector.ExploreRequest{
				Kind:   connector.ExploreMetricMetadata,
				Limit:  limitArg(in, 100),
				Metric: metric,
			})
			if err != nil {
				return nil, fmt.Errorf("get_metric_metadata: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreMetricMetadata, result), result.State)
		},
	}
}

func listTraceServicesTool(b Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_trace_services",
		Description: "List the service names a trace observability provider (Tempo) has spans for, so you can target a TraceQL query or interpret results by service.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "list_trace_services", "provider")
			if err != nil {
				return nil, err
			}
			result, err := b.Explore(ctx, provider, connector.ExploreRequest{
				Kind:  connector.ExploreTraceServices,
				Limit: limitArg(in, 100),
			})
			if err != nil {
				return nil, fmt.Errorf("list_trace_services: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreTraceServices, result), result.State)
		},
	}
}

// listProviderTypesTool is the list_provider_types tool: the provider-type
// catalog the library view renders — one light summary per backend the
// gateway can connect to, no config schema or walkthrough.
func listProviderTypesTool() mcp.Tool {
	return mcp.Tool{
		Name:        "list_provider_types",
		Description: "List the observability provider types this gateway can connect to: the catalog of backends (Prometheus, Loki, Tempo, OTLP, Google Cloud Logging/Monitoring/Trace, AWS CloudWatch Logs/Metrics, X-Ray, CloudTrail, Vultr Monitoring, mock) with vendor, category, supported signals and a one-line summary for each.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
		Invoke: func(_ context.Context, _ v1connect.PaprikaServiceClient, _ json.RawMessage) (any, error) {
			return map[string]any{
				"types":      catalog.Summaries(),
				"observedAt": observedAt(),
			}, nil
		},
	}
}

// describeProviderTypeTool is the describe_provider_type tool: the full
// TypeInfo for one provider type — display metadata, config-field schema,
// credential shape, onboarding steps and the probe shape — everything the
// onboarding wizard renders.
func describeProviderTypeTool() mcp.Tool {
	return mcp.Tool{
		Name:        "describe_provider_type",
		Description: "Describe one observability provider type: its display metadata, config-field schema, credential shape, onboarding steps and health-probe shape, as configured in this gateway's provider catalog.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{"type":{"type":"string"}},
			"required":["type"],
			"additionalProperties":false
		}`),
		Invoke: func(_ context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			providerType, err := requiredString(in, "describe_provider_type", "type")
			if err != nil {
				return nil, err
			}
			info, ok := catalog.Get(providerType)
			if !ok {
				return nil, connect.NewError(connect.CodeNotFound,
					fmt.Errorf("observability provider type %q is not in the catalog", providerType))
			}
			return info, nil
		},
	}
}

// validateToolResult is the validate_provider response: which provider type
// was probed, the probe's state verdict with its fixed-sentence reason, and
// the instant the probe ran. A Forbidden verdict is tool-success with the
// state in the payload — the same result-as-data contract the query tools
// honor.
type validateToolResult struct {
	Type       string          `json:"type"`
	State      connector.State `json:"state"`
	Reason     string          `json:"reason,omitempty"`
	ObservedAt string          `json:"observedAt"`
}

// validateProviderTool validates the shape of a prospective configuration.
// It never contacts a backend or accepts credential material.
func validateProviderTool() mcp.Tool {
	return mcp.Tool{
		Name:        "validate_provider",
		Description: "Validate a prospective provider configuration locally without contacting any backend or accepting credentials. OK means the configuration shape is valid; it does not establish connectivity or credential access. Query an approved provider to test access.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"type":{"type":"string"},
				"config":{"type":"object"}
			},
			"required":["type"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
			in, err := decodeArgs(args)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			providerType, err := requiredString(in, "validate_provider", "type")
			if err != nil {
				return nil, err
			}
			cfg, err := toolConfigObject(in)
			if err != nil {
				return nil, err
			}
			if _, present := in["credentials"]; present {
				return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("credential payloads are not accepted; configure a provider through the secure administration flow"))
			}

			result, err := validateProviderConfig(ctx, providerType, cfg, nil)
			if err != nil {
				return nil, fmt.Errorf("validate_provider: %w", err)
			}
			return validateToolResult{
				Type:       providerType,
				State:      result.State,
				Reason:     result.Reason,
				ObservedAt: observedAt(),
			}, nil
		},
	}
}

// toolConfigObject re-marshals the optional validate_provider "config"
// argument — a JSON object — into the canonical RawMessage a probe request
// carries. An absent or null argument yields nil, which the connectors read
// as "not configured"; any non-object value is a caller bug.
func toolConfigObject(in toolArgs) (json.RawMessage, error) {
	raw, ok := in["config"]
	if !ok || raw == nil {
		return nil, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("validate_provider: config must be a JSON object"))
	}
	cfg, err := json.Marshal(obj)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			errors.New("validate_provider: config must be a JSON object"))
	}
	return cfg, nil
}
