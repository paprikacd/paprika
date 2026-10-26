// Schema exploration for Amazon CloudWatch: metric names, dimension names
// and dimension values, enumerated through the ListMetrics API — the same
// call the CloudWatch console answers its "browse metrics" view with. Every
// kind maps onto ListMetrics with a different client-side projection:
// metric names union MetricName across pages, label names union
// Dimensions[].Name, and label values union Dimensions[].Value for the
// requested dimension name; results are wrapped in the
// {"status":"success","data":[...]} envelope because the union is computed
// here rather than returned by the backend.
//
// Scope: ListMetrics optionally takes a namespace. ExploreRequest.Params
// ["namespace"] scopes the enumeration when set; when absent every namespace
// the credential can see is explored, since discovery is most useful
// account-wide. The provider config's required namespace pins Query but does
// not restrict exploration. ExploreRequest.Metric, when set, is passed to
// ListMetrics as MetricName so label enumeration can be constrained to one
// metric the way the reference connectors constrain it.
//
// CloudWatch has no metric-metadata API — types, help text and units are not
// enumerable — so ExploreMetricMetadata reports StateNotAvailable, and the
// connector serves no trace signal at all.
//
// ListMetrics paginates by token and exposes no page-size parameter in the
// pinned SDK version, so ExploreRequest.Limit stops the page walk early once
// the union holds enough distinct entries, and the walk is capped at
// exploreMaxPages pages either way to bound cost.
package awscloudwatchmetrics

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// exploreMaxPages bounds every ListMetrics walk so one unbounded namespace
// cannot make exploration paginate indefinitely.
const exploreMaxPages = 20

// CloudWatchMetrics satisfies connector.Explorer: CloudWatch's ListMetrics
// API enumerates its metric and dimension schema.
var _ connector.Explorer = CloudWatchMetrics{}

// Explore enumerates one schema slice of the CloudWatch backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudWatchMetrics) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if reason := exploreShapeError(req.Kind, req.Label); reason != "" {
		return exploreUnsupported(reason)
	}

	client, _, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}
	input := exploreListMetricsInput(req.Params["namespace"], req.Metric)

	switch req.Kind {
	case connector.ExploreMetricNames:
		return exploreMetricNames(ctx, client, input, req.Prefix, req.Limit), nil
	case connector.ExploreLabelNames:
		return exploreDimensionNames(ctx, client, input, req.Limit), nil
	case connector.ExploreLabelValues:
		return exploreDimensionValues(ctx, client, input, req.Label, req.Limit), nil
	case connector.ExploreMetricMetadata, connector.ExploreMetricSeries, connector.ExploreTraceServices:
		return exploreUnsupported(exploreShapeError(req.Kind, req.Label))
	}
	// Unknown kinds were rejected by the shape check above.
	return exploreUnsupported(exploreShapeError(req.Kind, req.Label))
}

// exploreShapeError validates the request shape before configuration is
// parsed, mirroring Query's order; a non-empty return names the caller bug.
func exploreShapeError(kind connector.ExploreKind, label string) string {
	switch kind {
	case connector.ExploreMetricNames, connector.ExploreLabelNames:
		return ""
	case connector.ExploreLabelValues:
		if label == "" {
			return "a dimension name is required"
		}
		return ""
	case connector.ExploreMetricSeries:
		return "aws-cloudwatch-metrics connector does not enumerate metric series"
	case connector.ExploreMetricMetadata:
		return "cloudwatch has no metric metadata api; metric types, help text and units cannot be enumerated"
	case connector.ExploreTraceServices:
		return "aws-cloudwatch-metrics connector does not enumerate trace services"
	default:
		return fmt.Sprintf("exploration kind %q is not served by the aws-cloudwatch-metrics connector", kind)
	}
}

// exploreListMetricsInput builds the ListMetrics request: namespace-scoped
// when Params carries one, metric-scoped when Metric does.
func exploreListMetricsInput(namespace, metric string) *cloudwatch.ListMetricsInput {
	input := &cloudwatch.ListMetricsInput{}
	if namespace != "" {
		input.Namespace = aws.String(namespace)
	}
	if metric != "" {
		input.MetricName = aws.String(metric)
	}
	return input
}

// exploreMetricNames unions MetricName across ListMetrics pages, prefix-
// filtered and limited client-side.
func exploreMetricNames(ctx context.Context, client *cloudwatch.Client, input *cloudwatch.ListMetricsInput, prefix string, limit int) *connector.ExploreResult {
	set := map[string]struct{}{}
	err := walkListMetrics(ctx, client, input, func() int { return len(set) }, limit, func(out *cloudwatch.ListMetricsOutput) {
		for _, metric := range out.Metrics {
			if metric.MetricName != nil {
				set[*metric.MetricName] = struct{}{}
			}
		}
	})
	if err != nil {
		return exploreError(err)
	}
	return namesResult(filterKeys(set, prefix, limit))
}

// exploreDimensionNames unions Dimensions[].Name across ListMetrics pages —
// the closest CloudWatch has to a label-name enumeration.
func exploreDimensionNames(ctx context.Context, client *cloudwatch.Client, input *cloudwatch.ListMetricsInput, limit int) *connector.ExploreResult {
	set := map[string]struct{}{}
	err := walkListMetrics(ctx, client, input, func() int { return len(set) }, limit, func(out *cloudwatch.ListMetricsOutput) {
		for _, metric := range out.Metrics {
			for _, dimension := range metric.Dimensions {
				if dimension.Name != nil {
					set[*dimension.Name] = struct{}{}
				}
			}
		}
	})
	if err != nil {
		return exploreError(err)
	}
	return namesResult(sortedKeys(set, limit))
}

// exploreDimensionValues unions Dimensions[].Value for the requested
// dimension name across ListMetrics pages.
func exploreDimensionValues(ctx context.Context, client *cloudwatch.Client, input *cloudwatch.ListMetricsInput, label string, limit int) *connector.ExploreResult {
	set := map[string]struct{}{}
	err := walkListMetrics(ctx, client, input, func() int { return len(set) }, limit, func(out *cloudwatch.ListMetricsOutput) {
		for _, metric := range out.Metrics {
			for _, dimension := range metric.Dimensions {
				if dimension.Name == nil || *dimension.Name != label || dimension.Value == nil {
					continue
				}
				set[*dimension.Value] = struct{}{}
			}
		}
	})
	if err != nil {
		return exploreError(err)
	}
	return namesResult(sortedKeys(set, limit))
}

// walkListMetrics hands each ListMetrics page to visit, stopping early once
// collected (the cumulative union size) reaches limit (when positive) or
// after exploreMaxPages pages, whichever comes first. Page visitation errors
// are the backend's, wrapped for wrapcheck and returned for exploreError to
// classify.
func walkListMetrics(ctx context.Context, client *cloudwatch.Client, input *cloudwatch.ListMetricsInput, collected func() int, limit int, visit func(*cloudwatch.ListMetricsOutput)) error {
	paginator := cloudwatch.NewListMetricsPaginator(client, input)
	for page := 0; paginator.HasMorePages(); page++ {
		if page >= exploreMaxPages {
			return nil
		}
		out, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("listing metrics: %w", err)
		}
		visit(out)
		if limit > 0 && collected() >= limit {
			return nil
		}
	}
	return nil
}

// sortedKeys returns the set's keys sorted, capped at limit when positive so
// the early-stop bound carries through to the caller-visible result.
func sortedKeys(set map[string]struct{}, limit int) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if limit > 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	return keys
}

// filterKeys applies the optional substring Prefix and entry Limit: filter
// first, then limit, so the surviving names are the lexicographically
// first matches.
func filterKeys(set map[string]struct{}, prefix string, limit int) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		if prefix != "" && !strings.Contains(key, prefix) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if limit > 0 && len(keys) > limit {
		keys = keys[:limit]
	}
	return keys
}

// namesResult wraps a sorted string set in the {"status":"success",
// "data":[...]} shape the reference connectors answer in, so every
// exploration kind responds in one recognizable envelope.
func namesResult(items []string) *connector.ExploreResult {
	data, err := json.Marshal(struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}{Status: "success", Data: items})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}
}

// exploreUnsupported builds the result — and error — for an exploration kind
// the connector does not serve, mirroring Query's unsupported contract.
func exploreUnsupported(reason string) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// exploreError converts a backend failure into its sanitized result: the
// state classifies it and Reason is a fixed sentence, returned with a nil
// error per the connector error contract. Detail for logs travels in the
// handler's logs, not in the result.
func exploreError(err error) *connector.ExploreResult {
	state := awscommon.ClassifyError(err)
	return &connector.ExploreResult{State: state, Reason: awscommon.ReasonFor(state)}
}
