// Package awsxray implements connector.Connector for AWS X-Ray's read APIs.
// Only the traces signal is served. A request carrying TraceID fetches that
// one trace directly via BatchGetTraces; otherwise a Query runs as a filter
// expression against GetTraceSummaries, where an empty expression matches
// every trace in the window. GetTraceSummaries rejects requests without both
// time bounds, so a range missing either falls back to a trailing window —
// the hour for real queries, ten minutes for the probe, keeping the probe
// cheap. GetTraceSummaries paginates by NextToken and exposes no page-size
// parameter, so the connector enforces QueryRequest.Limit on the page it
// holds.
//
// An empty Query is the probe path: GetTraceSummaries over the short window
// limited to one trace — the same call a query makes, so a probe exercises
// exactly what a query would.
package awsxray

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/xray"
	"github.com/aws/aws-sdk-go-v2/service/xray/types"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Limit and window shaping. GetTraceSummaries pages by token, so the limits
// are enforced on the returned page; the probe asks for a single trace over
// the short window.
const (
	defaultLimit  = 50
	probeLimit    = 1
	maxLimit      = 100
	defaultWindow = time.Hour
	probeWindow   = 10 * time.Minute
)

// XRay is a connector for AWS X-Ray. It is a stateless struct; per-call state
// travels in connector.QueryRequest.
type XRay struct{}

// New returns an X-Ray connector.
func New() connector.Connector { return XRay{} }

// Descriptor advertises name, signals and network needs.
func (XRay) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderAWSXRay,
		Signals:     []connector.Signal{connector.SignalTraces},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// region, endpoint and insecureSkipTLS keys — ahead of use.
func (XRay) ValidateConfig(config json.RawMessage) error {
	if err := awscommon.ValidateConfig(config, nil); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query answers a direct trace fetch or a trace summary list. TraceID wins
// when both it and Query are set: a direct fetch is the more precise
// interpretation of what the caller asked for. An empty Query is the probe:
// summaries over the short window, limited to one trace.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (XRay) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalTraces {
		return unsupported("aws-xray connector supplies traces only")
	}
	client, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}

	switch {
	case req.TraceID != "":
		return queryTrace(ctx, client, req.TraceID)
	case req.Query == "":
		start, end := window(req.Range, probeWindow)
		return querySummaries(ctx, client, start, end, "", probeLimit)
	default:
		start, end := window(req.Range, defaultWindow)
		return querySummaries(ctx, client, start, end, req.Query, httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit))
	}
}

// setup validates the config document and assembles the service client.
// Config and credential-document problems are caller bugs, so they return as
// errors for the gateway to map rather than backend-failure results.
func setup(ctx context.Context, config json.RawMessage, credentialDocument []byte) (*xray.Client, error) {
	cfg, _, err := awscommon.ParseConfig(config, nil)
	if err != nil {
		return nil, fmt.Errorf("aws-xray: %w", err)
	}
	awsCfg, err := awscommon.NewAWSConfig(ctx, cfg, credentialDocument)
	if err != nil {
		return nil, fmt.Errorf("aws-xray: %w", err)
	}
	return xray.NewFromConfig(awsCfg, func(o *xray.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	}), nil
}

// queryTrace fetches one trace by ID via BatchGetTraces. A trace the backend
// does not know appears in UnprocessedTraceIds, not as an error, so a
// missing trace is still StateOK — the honest report of what happened.
func queryTrace(ctx context.Context, client *xray.Client, traceID string) (*connector.QueryResult, error) {
	out, err := client.BatchGetTraces(ctx, &xray.BatchGetTracesInput{
		TraceIds: []string{traceID},
	})
	if err != nil {
		return queryError(err), nil
	}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("aws-xray: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// querySummaries lists trace summaries over one window, applying the filter
// when non-empty and trimming the page to the caller's limit.
// GetTraceSummaries paginates by NextToken and exposes no page-size
// parameter, so the limit is enforced on the page the connector holds.
func querySummaries(ctx context.Context, client *xray.Client, start, end time.Time, filter string, limit int) (*connector.QueryResult, error) {
	input := &xray.GetTraceSummariesInput{
		StartTime: aws.Time(start),
		EndTime:   aws.Time(end),
	}
	if filter != "" {
		input.FilterExpression = aws.String(filter)
	}
	out, err := client.GetTraceSummaries(ctx, input)
	if err != nil {
		return queryError(err), nil
	}
	out.TraceSummaries = trim(out.TraceSummaries, limit)
	data, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("aws-xray: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// window resolves the start/end pair GetTraceSummaries requires. Both bounds
// set are used as given; anything else falls back to a trailing window of
// width fallback, because the API rejects requests missing either bound.
func window(r connector.TimeRange, fallback time.Duration) (start, end time.Time) {
	if !r.Start.IsZero() && !r.End.IsZero() {
		return r.Start, r.End
	}
	end = time.Now()
	return end.Add(-fallback), end
}

// trim caps a summaries page at limit entries. GetTraceSummaries paginates by
// NextToken and exposes no page-size parameter, so the connector enforces
// the caller's limit on the page it already holds.
func trim(summaries []types.TraceSummary, limit int) []types.TraceSummary {
	if len(summaries) > limit {
		return summaries[:limit]
	}
	return summaries
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
// state classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func queryError(err error) *connector.QueryResult {
	state := awscommon.ClassifyError(err)
	return &connector.QueryResult{State: state, Reason: awscommon.ReasonFor(state)}
}
