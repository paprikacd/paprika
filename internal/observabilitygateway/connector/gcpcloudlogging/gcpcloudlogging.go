// Package gcpcloudlogging implements connector.Connector for Google Cloud
// Logging's entries:list API. Only the logs signal is served, and queries
// carry the Logging advanced logs filter.
//
// The advanced logs filter owns time: QueryRequest.Range is deliberately not
// translated into filter constraints, because synthesizing `timestamp >= ...`
// clauses would fight a filter the caller already wrote (duplicate
// constraints are an API error), and an empty filter is the honest probe
// path — the API reads it as "most recent entries".
package gcpcloudlogging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/gcpcommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Cloud Logging API path and page-size shaping. pageSize tops out at the
// documented 1000; the probe asks for a single entry.
const (
	defaultEndpoint = "https://logging.googleapis.com"
	pathEntriesList = "/v2/entries:list"
	defaultLimit    = 100
	probeLimit      = 1
	maxLimit        = 1000
)

// CloudLogging is a connector for Google Cloud Logging. It is a stateless
// struct; per-call state travels in connector.QueryRequest.
type CloudLogging struct{}

// New returns a Cloud Logging connector.
func New() connector.Connector { return CloudLogging{} }

// Descriptor advertises name, signals and network needs.
func (CloudLogging) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderGCPCloudLogging,
		Signals:     []connector.Signal{connector.SignalLogs},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// projectId, endpoint and insecureSkipTLS keys — ahead of use.
func (CloudLogging) ValidateConfig(config json.RawMessage) error {
	if err := gcpcommon.ValidateConfig(config); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one entries:list request against the project's log entries,
// newest first. An empty Query is the probe path: the same entries:list call
// with a one-entry page, which reads as "most recent entry".
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudLogging) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalLogs {
		return unsupported("gcp-cloudlogging connector supplies logs only")
	}
	if req.TraceID != "" {
		return unsupported("a trace ID cannot be fetched from cloud logging")
	}
	cfg, err := gcpcommon.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudlogging: %w", err)
	}
	project, err := gcpcommon.ResolveProject(cfg.ProjectID, req.Credentials)
	if err != nil {
		return queryError(err), nil
	}
	client, err := gcpcommon.Client(ctx, req.Credentials, cfg.InsecureSkipTLS)
	if err != nil {
		result, credErr := credentialError(err)
		return result, credErr
	}

	// The caller's filter owns time, so QueryRequest.Range is not translated
	// into filter constraints; see the package doc.
	limit := httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit)
	if req.Query == "" {
		limit = httphelp.ClampLimit(req.Limit, probeLimit, maxLimit)
	}
	body, err := json.Marshal(entriesListRequest{
		ResourceNames: []string{"projects/" + project},
		Filter:        req.Query,
		PageSize:      limit,
		OrderBy:       "timestamp desc",
	})
	if err != nil {
		return nil, fmt.Errorf("gcp-cloudlogging: building entries:list body: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		gcpcommon.URL(cfg, defaultEndpoint, pathEntriesList, nil), bytes.NewReader(body))
	if err != nil {
		// The URL is not echoed: with a validated endpoint and a fixed path
		// this is unreachable, and if it is reached the message must not
		// carry the endpoint.
		return nil, errors.New("building backend request: invalid endpoint or path")
	}
	httpReq.Header.Set("Content-Type", "application/json")

	data, err := gcpcommon.Do(httpReq, client)
	if err != nil {
		return queryError(err), nil
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// entriesListRequest is the Cloud Logging entries:list request body. The
// filter is omitted entirely when empty — the API reads an absent filter as
// "all entries, most recent first".
type entriesListRequest struct {
	ResourceNames []string `json:"resourceNames"`
	Filter        string   `json:"filter,omitempty"`
	PageSize      int      `json:"pageSize"`
	OrderBy       string   `json:"orderBy"`
}

// unsupported builds the result — and error — for a query shape the
// connector does not serve. The result carries the fixed user-facing
// sentence; the error wraps connector.ErrUnsupported so the caller bug can
// be classified programmatically.
func unsupported(reason string) (*connector.QueryResult, error) {
	return &connector.QueryResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// queryError converts a backend failure into its sanitized result: the
// State classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func queryError(err error) *connector.QueryResult {
	state := gcpcommon.ClassifyState(err)
	return &connector.QueryResult{State: state, Reason: gcpcommon.ReasonFor(state)}
}

// credentialError maps a credential-construction failure onto the dual
// result+error contract: the fixed user-facing sentence travels in the
// result, connector-wrapped sanitized detail in the error for logs.
func credentialError(err error) (*connector.QueryResult, error) {
	result, credErr := gcpcommon.CredentialError(err)
	return result, fmt.Errorf("gcp-cloudlogging: %w", credErr)
}
