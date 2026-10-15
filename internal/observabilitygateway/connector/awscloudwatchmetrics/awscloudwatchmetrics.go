// Package awscloudwatchmetrics implements connector.Connector for Amazon
// CloudWatch's statistics read APIs. Only the metrics signal is served, and
// queries carry the metric name; the namespace comes from the provider
// config and the statistics are always Average, Sum and Maximum. The period
// derives from the query window — one bucket per hundredth of the span,
// clamped to CloudWatch's sane bounds — because a fixed period makes either
// long windows (one huge bucket) or short ones (thousands of buckets)
// useless. GetMetricStatistics requires both bounds, so a range missing
// either falls back to the trailing hour.
//
// An empty Query is the probe path: ListMetrics scoped to the configured
// namespace, the lightest read CloudWatch offers; the response is returned
// as {"metrics": [...]}.
//
// The CloudWatch SDK client speaks the rpc-v2-cbor protocol, so responses
// arrive CBOR-encoded; the connector marshals the decoded SDK output to JSON
// like every other connector. QueryRequest.Limit is not applied: statistics
// are a computed series bounded by the period clamp, and ListMetrics exposes
// no page-size parameter in the pinned SDK version.
package awscloudwatchmetrics

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// Config key and period shaping. Period is in seconds: the default matches
// CloudWatch's own console default, the bounds keep any single request sane.
const (
	configKeyNamespace       = "namespace"
	defaultPeriod      int32 = 300
	minPeriod          int32 = 60
	maxPeriod          int32 = 3600
	periodDivisor            = 100

	// defaultWindow backs a GetMetricStatistics call whose range misses a
	// bound, which the API rejects: the trailing hour is the house default.
	defaultWindow = time.Hour
)

// CloudWatchMetrics is a connector for Amazon CloudWatch metrics. It is a
// stateless struct; per-call state travels in connector.QueryRequest.
type CloudWatchMetrics struct{}

// New returns a CloudWatch Metrics connector.
func New() connector.Connector { return CloudWatchMetrics{} }

// Descriptor advertises name, signals and network needs.
func (CloudWatchMetrics) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderAWSCloudWatchMetrics,
		Signals:     []connector.Signal{connector.SignalMetrics},
		NeedsEgress: true,
	}
}

// ValidateConfig checks the strict connector configuration — the shared
// region, endpoint and insecureSkipTLS keys plus the required namespace —
// ahead of use.
func (CloudWatchMetrics) ValidateConfig(config json.RawMessage) error {
	_, extras, err := awscommon.ParseConfig(config, []string{configKeyNamespace})
	if err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	if _, err := awscommon.RequiredString(extras, configKeyNamespace); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query runs one metric lookup. An empty Query is the probe: ListMetrics for
// the configured namespace. Otherwise GetMetricStatistics answers the metric
// name over the request window.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudWatchMetrics) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	if req.Signal != connector.SignalMetrics {
		return unsupported("aws-cloudwatch-metrics connector supplies metrics only")
	}
	client, namespace, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}
	if req.Query == "" {
		return queryMetrics(ctx, client, namespace)
	}
	return queryStatistics(ctx, client, namespace, req.Query, req.Range)
}

// setup validates the config document and assembles the service client.
// Config and credential-document problems are caller bugs, so they return as
// errors for the gateway to map rather than backend-failure results.
func setup(ctx context.Context, config json.RawMessage, credentialDocument []byte) (*cloudwatch.Client, string, error) {
	cfg, extras, err := awscommon.ParseConfig(config, []string{configKeyNamespace})
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-metrics: %w", err)
	}
	namespace, err := awscommon.RequiredString(extras, configKeyNamespace)
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-metrics: %w", err)
	}
	awsCfg, err := awscommon.NewAWSConfig(ctx, cfg, credentialDocument)
	if err != nil {
		return nil, "", fmt.Errorf("aws-cloudwatch-metrics: %w", err)
	}
	return cloudwatch.NewFromConfig(awsCfg, func(o *cloudwatch.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	}), namespace, nil
}

// queryMetrics is the probe path: ListMetrics scoped to the configured
// namespace, the lightest read CloudWatch offers.
func queryMetrics(ctx context.Context, client *cloudwatch.Client, namespace string) (*connector.QueryResult, error) {
	out, err := client.ListMetrics(ctx, &cloudwatch.ListMetricsInput{
		Namespace: aws.String(namespace),
	})
	if err != nil {
		return queryError(err), nil
	}
	data, err := json.Marshal(struct {
		Metrics []types.Metric `json:"metrics"`
	}{Metrics: out.Metrics})
	if err != nil {
		return nil, fmt.Errorf("aws-cloudwatch-metrics: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// queryStatistics answers one metric name over the request window.
// GetMetricStatistics requires both bounds, so a range missing either falls
// back to the trailing hour.
func queryStatistics(ctx context.Context, client *cloudwatch.Client, namespace, metric string, r connector.TimeRange) (*connector.QueryResult, error) {
	start, end := r.Start, r.End
	if start.IsZero() || end.IsZero() {
		end = time.Now()
		start = end.Add(-defaultWindow)
	}
	out, err := client.GetMetricStatistics(ctx, &cloudwatch.GetMetricStatisticsInput{
		Namespace:  aws.String(namespace),
		MetricName: aws.String(metric),
		StartTime:  aws.Time(start),
		EndTime:    aws.Time(end),
		Period:     aws.Int32(period(r)),
		Statistics: []types.Statistic{types.StatisticAverage, types.StatisticSum, types.StatisticMaximum},
	})
	if err != nil {
		return queryError(err), nil
	}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("aws-cloudwatch-metrics: encoding backend response: %w", err)
	}
	return &connector.QueryResult{State: connector.StateOK, Data: data}, nil
}

// period derives the statistics period in seconds from the query window: one
// bucket per hundredth of the span, clamped to [minPeriod, maxPeriod]. A
// range without both bounds uses the default period, matching the default
// window Query substitutes for it.
func period(r connector.TimeRange) int32 {
	if r.Start.IsZero() || r.End.IsZero() {
		return defaultPeriod
	}
	derived := int64(r.End.Sub(r.Start).Seconds()) / periodDivisor
	switch {
	case derived < int64(minPeriod):
		return minPeriod
	case derived > int64(maxPeriod):
		return maxPeriod
	default:
		return int32(derived)
	}
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
