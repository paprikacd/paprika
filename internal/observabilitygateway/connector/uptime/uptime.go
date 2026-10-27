// Package uptime exposes a fixed set of read-only Uptime Connect RPCs as
// bounded record frames or explicitly projected metric observations.
package uptime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

const (
	maxRows       = 100
	maxQueryBytes = 16 << 10
	queryTimeout  = 20 * time.Second
)

// Uptime keeps no organization or credential state between queries.
type Uptime struct{}

// New returns the Uptime application data connector.
func New() connector.Connector { return Uptime{} }

// Descriptor advertises the two explicit views of application data.
func (Uptime) Descriptor() connector.Descriptor {
	return connector.Descriptor{Name: "uptime", Signals: []connector.Signal{connector.SignalMetrics, connector.Signal("records")}, NeedsEgress: true}
}

type config struct {
	httphelp.Config
	OrgID string
}

func parseConfig(raw json.RawMessage) (config, error) {
	if err := checkJSON(string(raw)); err != nil {
		return config{}, err
	}
	base, err := httphelp.ParseConfigWithKeys(raw, []string{"orgId"})
	if err != nil {
		return config{}, errors.New("uptime requires a valid endpoint and organization configuration")
	}
	var fields struct {
		OrgID string `json:"orgId"`
	}
	if decodeErr := json.Unmarshal(raw, &fields); decodeErr != nil {
		return config{}, errors.New("uptime orgId must be a UUID")
	}
	id, err := uuid.Parse(fields.OrgID)
	if err != nil || id == uuid.Nil {
		return config{}, errors.New("uptime orgId must be a UUID")
	}
	return config{Config: base, OrgID: id.String()}, nil
}

// ValidateConfig admits only shared HTTP options plus the pinned organization.
func (Uptime) ValidateConfig(raw json.RawMessage) error {
	_, err := parseConfig(raw)
	return err
}

type query struct {
	Operation  string                `json:"operation"`
	Args       queryArgs             `json:"args,omitempty"`
	Projection *dataframe.Projection `json:"projection,omitempty"`
}

type queryArgs struct {
	WindowDays   *int   `json:"windowDays,omitempty"`
	BreachedOnly *bool  `json:"breachedOnly,omitempty"`
	ServiceID    string `json:"serviceId,omitempty"`
	Limit        *int   `json:"limit,omitempty"`
}

func decodeQuery(raw string, signal connector.Signal) (query, error) {
	var q query
	if raw == "" || len(raw) > maxQueryBytes {
		return q, errors.New("uptime requires a bounded JSON query")
	}
	if err := checkJSON(raw); err != nil {
		return q, err
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&q); err != nil {
		return q, errors.New("uptime query contains invalid or unknown fields")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return q, errors.New("uptime query must contain one JSON object")
	}
	if err := validateQuery(&q, signal); err != nil {
		return q, err
	}
	return q, nil
}

func validateQuery(q *query, signal connector.Signal) error {
	if !knownOperation(q.Operation) {
		return errors.New("uptime operation is not an allowed read")
	}
	if (signal == connector.SignalMetrics) != (q.Projection != nil) {
		return errors.New("uptime metrics require a projection; records must omit projection")
	}
	if err := validateProjection(q.Projection); err != nil {
		return err
	}
	if q.Args.Limit != nil && (*q.Args.Limit < 1 || *q.Args.Limit > maxRows) {
		return errors.New("uptime limit must be between 1 and 100")
	}
	if q.Args.ServiceID != "" {
		if _, err := uuid.Parse(q.Args.ServiceID); err != nil {
			return errors.New("uptime serviceId must be a UUID")
		}
	}
	return validateOperationArgs(q)
}

func validateProjection(projection *dataframe.Projection) error {
	if projection == nil {
		return nil
	}
	if projection.Value == "" || len(projection.Labels) > 16 {
		return errors.New("uptime projection requires a value and at most 16 labels")
	}
	for _, key := range projection.Labels {
		switch key {
		case "serviceId", "serviceName", "serviceSlug", "checkId", "checkName", "checkType", "status", "enabled", "riskLevel", "reportId", "category", "severity", "availability", "windowDays", "burnStatus", "observed":
		default:
			return errors.New("uptime projection label must be a declared bounded dimension, not narrative content")
		}
	}
	return nil
}

func knownOperation(operation string) bool {
	switch operation {
	case "overview", "services", "check_summaries", "security_summaries", "alert_events", "service_signals", "slo", "slo_summary", "reliability_insights", "reliability_summary":
		return true
	default:
		return false
	}
}

func validateOperationArgs(q *query) error {
	if q.Args.BreachedOnly != nil && q.Operation != "slo" {
		return errors.New("uptime breachedOnly is supported only by SLO records")
	}
	if q.Args.WindowDays != nil {
		if q.Operation != "slo" && q.Operation != "slo_summary" {
			return errors.New("uptime windowDays is supported only by SLO reads")
		}
		switch *q.Args.WindowDays {
		case 7, 14, 30, 60, 90:
		default:
			return errors.New("uptime windowDays must be 7, 14, 30, 60 or 90")
		}
	}
	if q.Args.ServiceID != "" {
		switch q.Operation {
		case "overview", "alert_events", "reliability_insights", "reliability_summary":
			return errors.New("this uptime operation is organization scoped and does not support serviceId")
		}
	}
	return nil
}

// Query calls only fixed read procedures. No query can select an endpoint,
// organization, arbitrary RPC, authorization header, or generation action.
//
//nolint:gocritic // Connector interface deliberately passes QueryRequest by value.
func (Uptime) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalMetrics && req.Signal != connector.Signal("records") {
		return unsupported("uptime supplies metrics and records only")
	}
	if req.TraceID != "" || req.PageToken != "" {
		return unsupported("uptime does not support trace IDs or pagination tokens")
	}
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, err
	}
	q, err := decodeQuery(req.Query, req.Signal)
	if err != nil {
		return unsupported(err.Error())
	}
	return executeQuery(ctx, &req, &cfg, &q)
}

func executeQuery(ctx context.Context, req *connector.QueryRequest, cfg *config, q *query) (*connector.QueryResult, error) {
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	credential, credentialErr := bearerCredential(ctx, req.Credentials, &http.Client{Transport: transport, CheckRedirect: httphelp.RejectRedirect})
	if credentialErr != nil {
		return credentialFailure(credentialErr), nil
	}
	limit := httphelp.ClampLimit(req.Limit, maxRows, maxRows)
	if q.Args.Limit != nil {
		limit = min(limit, *q.Args.Limit)
	}
	reader := backend{config: cfg, credential: credential, limit: limit}
	frame, err := reader.read(ctx, q)
	if err != nil {
		state := httphelp.ClassifyState(err)
		return &connector.QueryResult{State: state, Reason: httphelp.ReasonFor(state)}, nil
	}
	if err := dataframe.Validate(frame); err != nil {
		return &connector.QueryResult{State: connector.StateError, Reason: "uptime returned invalid or oversized application data"}, nil
	}
	return encodeResult(frame, q.Projection, req.Range.End)
}

func credentialFailure(err error) *connector.QueryResult {
	state := httphelp.ClassifyState(err)
	if state == connector.StateNotConfigured {
		return &connector.QueryResult{State: state, Reason: "uptime requires a bearer or Firebase refresh credential from credentialsSecretRef"}
	}
	return &connector.QueryResult{State: state, Reason: httphelp.ReasonFor(state)}
}

func encodeResult(frame *dataframe.Frame, projection *dataframe.Projection, end time.Time) (*connector.QueryResult, error) {
	var data json.RawMessage
	var err error
	if projection == nil {
		data, err = json.Marshal(frame)
	} else {
		data, err = dataframe.Prometheus(frame, *projection, end)
	}
	if err != nil {
		return unsupported("uptime projection requires valid distinct numeric observations and declared columns")
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{State: connector.StateNotAvailable, Reason: reason}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}
