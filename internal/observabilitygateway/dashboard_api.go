package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const dashboardBodyLimit = 128 << 10

// DashboardQueryRequest contains only query inputs. Provider configuration and
// credentials always come from the authorized ObservabilityProvider record.
type DashboardQueryRequest struct {
	Provider    string           `json:"provider"`
	Signal      connector.Signal `json:"signal"`
	Query       string           `json:"query"`
	TraceID     string           `json:"traceId,omitempty"`
	Start       time.Time        `json:"start"`
	End         time.Time        `json:"end"`
	StepSeconds float64          `json:"stepSeconds,omitempty"`
	Instant     bool             `json:"instant,omitempty"`
	Limit       int              `json:"limit,omitempty"`
	PageToken   string           `json:"pageToken,omitempty"`
}

// DashboardQueryResponse preserves the same native payload and outcome as MCP.
type DashboardQueryResponse = queryToolResult

// DashboardProvidersResponse lists only providers visible to this principal.
type DashboardProvidersResponse struct {
	Providers  []ProviderInfo `json:"providers"`
	ObservedAt string         `json:"observedAt"`
}

// DashboardExploreRequest selects a bounded slice of provider schema.
type DashboardExploreRequest struct {
	Provider string                `json:"provider"`
	Kind     connector.ExploreKind `json:"kind"`
	Metric   string                `json:"metric,omitempty"`
	Label    string                `json:"label,omitempty"`
	Prefix   string                `json:"prefix,omitempty"`
	Limit    int                   `json:"limit,omitempty"`
	Params   map[string]string     `json:"params,omitempty"`
	Start    time.Time             `json:"start,omitempty"`
	End      time.Time             `json:"end,omitempty"`
}

// DashboardExploreResponse preserves provider states, including unsupported
// discovery, rather than representing an unavailable capability as an empty list.
type DashboardExploreResponse struct {
	Provider   string                `json:"provider"`
	Kind       connector.ExploreKind `json:"kind"`
	State      connector.State       `json:"state"`
	Reason     string                `json:"reason,omitempty"`
	Data       json.RawMessage       `json:"data,omitempty"`
	ObservedAt string                `json:"observedAt"`
}

// DashboardProvidersHandler serves credential-free provider discovery. Production
// callers must wrap every dashboard handler in RequireObserveScope and supply
// the same NewAuthorizedBackend instance used by MCP.
func DashboardProvidersHandler(backend Backend, usage *UsageTracker) http.Handler {
	return dashboardHandler(usage, "dashboard_list_providers", func(ctx context.Context, w http.ResponseWriter, _ *http.Request) error {
		providers, err := backend.ListProviders(ctx)
		if err != nil {
			return fmt.Errorf("list dashboard providers: %w", err)
		}
		if providers == nil {
			providers = []ProviderInfo{}
		}
		return writeDashboardJSON(w, DashboardProvidersResponse{Providers: providers, ObservedAt: observedAt()})
	})
}

// DashboardQueryHandler runs a native query through the shared authorized backend.
func DashboardQueryHandler(backend Backend, usage *UsageTracker) http.Handler {
	return dashboardHandler(usage, "dashboard_query", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		var input DashboardQueryRequest
		if err := decodeDashboardRequest(w, r, &input); err != nil {
			return err
		}
		request, err := input.connectorRequest()
		if err != nil {
			return err
		}
		result, err := backend.Query(ctx, input.Provider, request)
		if err != nil {
			return fmt.Errorf("query dashboard provider: %w", err)
		}
		if result == nil {
			return errors.New("provider returned no result")
		}
		result = boundedRecordResult(input.Signal, result)
		if err := writeDashboardJSON(w, queryToolResponse(input.Provider, string(input.Signal), result)); err != nil {
			return err
		}
		return dashboardOutcome(result.State)
	})
}

// DashboardExploreHandler shares schema discovery with the MCP tools.
func DashboardExploreHandler(backend Backend, usage *UsageTracker) http.Handler {
	return dashboardHandler(usage, "dashboard_explore", func(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
		var input DashboardExploreRequest
		if err := decodeDashboardRequest(w, r, &input); err != nil {
			return err
		}
		request, err := input.connectorRequest()
		if err != nil {
			return err
		}
		result, err := backend.Explore(ctx, input.Provider, request)
		if err != nil {
			return fmt.Errorf("explore dashboard provider: %w", err)
		}
		if result == nil {
			return errors.New("provider returned no result")
		}
		if err := writeDashboardJSON(w, DashboardExploreResponse{
			Provider: input.Provider, Kind: input.Kind, State: result.State,
			Reason: result.Reason, Data: result.Data, ObservedAt: observedAt(),
		}); err != nil {
			return err
		}
		return dashboardOutcome(result.State)
	})
}

// A non-OK provider state is already serialized as data; record a failed outcome
// without appending a second HTTP response.
var errDashboardOutcome = errors.New("provider returned an unavailable result")

func dashboardOutcome(state connector.State) error {
	if state != connector.StateOK {
		return errDashboardOutcome
	}
	return nil
}

func dashboardHandler(usage *UsageTracker, operation string, run func(context.Context, http.ResponseWriter, *http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), queryTimeout)
		defer cancel()
		err := run(ctx, w, r)
		if usage != nil {
			usage.Record(operation, err)
		}
		if err != nil && !errors.Is(err, errDashboardOutcome) {
			writeDashboardError(w, err)
		}
	})
}

func decodeDashboardRequest(w http.ResponseWriter, r *http.Request, value any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, dashboardBodyLimit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return invalidDashboardRequest()
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return invalidDashboardRequest()
	}
	return nil
}

func invalidDashboardRequest() error {
	return connect.NewError(connect.CodeInvalidArgument, errors.New("invalid observability request"))
}

func validDashboardProvider(provider string) bool {
	namespace, name, found := strings.Cut(provider, "/")
	return found && len(validation.IsDNS1123Label(namespace)) == 0 && len(validation.IsDNS1123Subdomain(name)) == 0
}

func (in *DashboardQueryRequest) connectorRequest() (connector.QueryRequest, error) {
	if !validDashboardProvider(in.Provider) || in.Start.IsZero() || in.End.IsZero() ||
		!in.validSignalQuery() || !in.validMetricOptions() {
		return connector.QueryRequest{}, invalidDashboardRequest()
	}
	req := connector.QueryRequest{
		Signal: in.Signal, Query: in.Query, TraceID: in.TraceID,
		Range: connector.TimeRange{Start: in.Start, End: in.End},
		Step:  time.Duration(in.StepSeconds * float64(time.Second)), Instant: in.Instant,
		Limit: in.Limit, PageToken: in.PageToken,
	}
	if err := boundQuery(&req); err != nil {
		return connector.QueryRequest{}, err
	}
	return req, nil
}

func (in *DashboardQueryRequest) validSignalQuery() bool {
	switch in.Signal {
	case connector.SignalMetrics, connector.SignalLogs, connector.SignalRecords:
		return strings.TrimSpace(in.Query) != "" && in.TraceID == ""
	case connector.SignalTraces:
		return strings.TrimSpace(in.Query) != "" || in.TraceID != ""
	default:
		return false
	}
}

func (in *DashboardQueryRequest) validMetricOptions() bool {
	if in.Signal != connector.SignalMetrics {
		return in.StepSeconds == 0 && !in.Instant
	}
	if in.StepSeconds == 0 {
		return true
	}
	return !math.IsNaN(in.StepSeconds) && !math.IsInf(in.StepSeconds, 0) &&
		in.StepSeconds >= 1 && in.StepSeconds <= maxQueryWindow.Seconds()
}

func (in *DashboardExploreRequest) connectorRequest() (connector.ExploreRequest, error) {
	if !validDashboardProvider(in.Provider) {
		return connector.ExploreRequest{}, invalidDashboardRequest()
	}
	switch in.Kind {
	case connector.ExploreMetricNames, connector.ExploreLabelNames, connector.ExploreTraceServices:
	case connector.ExploreLabelValues:
		if strings.TrimSpace(in.Label) == "" {
			return connector.ExploreRequest{}, invalidDashboardRequest()
		}
	case connector.ExploreMetricMetadata, connector.ExploreMetricSeries:
		if strings.TrimSpace(in.Metric) == "" {
			return connector.ExploreRequest{}, invalidDashboardRequest()
		}
	default:
		return connector.ExploreRequest{}, invalidDashboardRequest()
	}
	req := connector.ExploreRequest{
		Kind: in.Kind, Metric: in.Metric, Label: in.Label, Prefix: in.Prefix,
		Limit: in.Limit, Params: in.Params, Range: connector.TimeRange{Start: in.Start, End: in.End},
	}
	if err := boundExplore(&req); err != nil {
		return connector.ExploreRequest{}, err
	}
	return req, nil
}

func writeDashboardJSON(w http.ResponseWriter, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > httphelp.MaxResponseBytes {
		return errors.New("observability response exceeds its size limit or is invalid")
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	// #nosec G705 -- json.Marshal escapes HTML and the content type is application/json.
	_, _ = w.Write(data) //nolint:errcheck // The response has already started.
	return nil
}

func writeDashboardError(w http.ResponseWriter, err error) {
	status, code, description := http.StatusBadGateway, "server_error", "observability provider request failed"
	switch connect.CodeOf(err) {
	case connect.CodeInvalidArgument:
		status, code, description = http.StatusBadRequest, "invalid_request", "observability request is invalid or exceeds its limits"
	case connect.CodeUnauthenticated:
		status, code, description = http.StatusUnauthorized, "invalid_token", "an authenticated observability principal is required"
	case connect.CodePermissionDenied:
		status, code, description = http.StatusForbidden, "access_denied", "observability provider access is not authorized"
	case connect.CodeNotFound:
		status, code, description = http.StatusNotFound, "not_found", "observability provider was not found"
	case connect.CodeResourceExhausted:
		status, code, description = http.StatusTooManyRequests, "temporarily_unavailable", "observability gateway is at its request limit; retry later"
		w.Header().Set("Retry-After", "1")
	case connect.CodeDeadlineExceeded:
		status, code, description = http.StatusGatewayTimeout, "temporarily_unavailable", "observability request exceeded its time budget"
	case connect.CodeCanceled:
		status, code, description = http.StatusRequestTimeout, "temporarily_unavailable", "observability request was canceled"
	case connect.CodeUnknown, connect.CodeAlreadyExists, connect.CodeAborted, connect.CodeOutOfRange,
		connect.CodeUnimplemented, connect.CodeInternal, connect.CodeUnavailable, connect.CodeDataLoss:
		// These failures use the sanitized provider error above.
	case connect.CodeFailedPrecondition:
		status, code, description = http.StatusServiceUnavailable, "temporarily_unavailable", "observability provider is not fully configured"
	}
	writeGatewayJSON(w, status, gatewayError{Error: code, ErrorDescription: description})
}
