// Package awscloudwatchlogs implements connector.Connector for Amazon
// CloudWatch Logs' FilterLogEvents API. Only the logs signal is served, and
// queries carry the CloudWatch filter pattern — the term and phrase syntax
// CloudWatch documents — where an empty pattern matches every event. The
// log group comes from the provider config; range bounds translate to
// startTime/endTime in milliseconds as the API expects.
//
// An empty Query is the probe path: FilterLogEvents with no pattern and a
// one-event limit. That succeeds against an existing but empty log group and
// fails honestly when the group is absent or the credential is refused, which
// is the right health signal for a logs backend — and it keeps one code path
// for probes and queries.
package awscloudwatchlogs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Config key and limit shaping. FilterLogEvents caps a page at 1000 events;
// 100 is a sane default, and the probe asks for a single event.
const (
	configKeyLogGroup = "logGroup"
	defaultLimit      = 100
	probeLimit        = 1
	maxLimit          = 1000
)

// CloudWatchLogs is a connector for Amazon CloudWatch Logs. It is a stateless
// struct; per-call state travels in connector.QueryRequest.
type CloudWatchLogs struct{}

// New returns a CloudWatch Logs connector.
func New() connector.Connector { return CloudWatchLogs{} }

// Descriptor advertises name, signals and network needs.
func (CloudWatchLogs) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderAWSCloudWatchLogs,
		Signals:     []connector.Signal{connector.SignalLogs},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// region, endpoint and insecureSkipTLS keys plus the required logGroup —
// ahead of use.
func (CloudWatchLogs) ValidateConfig(config json.RawMessage) error {
	_, extras, err := awscommon.ParseConfig(config, []string{configKeyLogGroup})
	if err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	if _, err := awscommon.RequiredString(extras, configKeyLogGroup); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one filter against the configured log group. An empty Query is
// the probe: no pattern, one event. Range bounds are passed in milliseconds
// only when set; a zero bound stays unbounded, as the connector contract
// promises.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudWatchLogs) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalLogs {
		return unsupported("aws-cloudwatch-logs connector supplies logs only")
	}
	if req.TraceID != "" {
		return unsupported("aws-cloudwatch-logs connector does not fetch traces by ID")
	}
	client, logGroup, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}

	input := &cloudwatchlogs.FilterLogEventsInput{LogGroupName: aws.String(logGroup)}
	if req.Query == "" {
		// Probe: no pattern, one event — succeeds against an empty group.
		input.Limit = aws.Int32(probeLimit)
	} else {
		input.FilterPattern = aws.String(req.Query)
		input.Limit = aws.Int32(int32(httphelp.ClampLimit(req.Limit, defaultLimit, maxLimit))) //nolint:gosec // G115: ClampLimit bounds the value to [1, 1000].
	}
	if !req.Range.Start.IsZero() {
		input.StartTime = aws.Int64(req.Range.Start.UnixMilli())
	}
	if !req.Range.End.IsZero() {
		input.EndTime = aws.Int64(req.Range.End.UnixMilli())
	}

	out, err := client.FilterLogEvents(ctx, input)
	if err != nil {
		return queryError(err), nil
	}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("aws-cloudwatch-logs: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// setup validates the config document and assembles the service client.
// Config and credential-document problems are caller bugs, so they return as
// errors for the gateway to map rather than backend-failure results.
func setup(ctx context.Context, config json.RawMessage, credentialDocument []byte) (*cloudwatchlogs.Client, string, error) {
	cfg, extras, err := awscommon.ParseConfig(config, []string{configKeyLogGroup})
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-logs: %w", err)
	}
	logGroup, err := awscommon.RequiredString(extras, configKeyLogGroup)
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-logs: %w", err)
	}
	awsCfg, err := awscommon.NewAWSConfig(ctx, cfg, credentialDocument)
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-logs: %w", err)
	}
	return cloudwatchlogs.NewFromConfig(awsCfg, func(o *cloudwatchlogs.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	}), logGroup, nil
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
