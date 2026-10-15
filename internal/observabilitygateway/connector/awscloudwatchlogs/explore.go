// Schema exploration for Amazon CloudWatch Logs: the metric-filter names one
// log group carries, enumerated through the DescribeMetricFilters API —
// the only name-like catalog CloudWatch Logs exposes. The connector serves
// metric_names only: a metric filter is the way a logs operator names a
// queryable quantity, so the names are what "what can I query here" means
// for this backend. Label kinds have no counterpart — log fields are not
// enumerable without scanning events — and metric metadata does not exist.
//
// The enumeration is scoped to the provider config's logGroup, the same
// scope Query filters by. DescribeMetricFilters paginates by token; the
// connector walks every page (capped at exploreMaxPages), unions the filter
// names client-side, and wraps them in the {"status":"success","data":[...]}
// envelope, applying ExploreRequest.Limit after the union.
package awscloudwatchlogs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// exploreMaxPages bounds every DescribeMetricFilters walk so one log group
// with thousands of filters cannot paginate indefinitely.
const exploreMaxPages = 20

// CloudWatchLogs satisfies connector.Explorer: DescribeMetricFilters
// enumerates the metric-filter names a log group carries.
var _ connector.Explorer = CloudWatchLogs{}

// Explore enumerates one schema slice of the CloudWatch Logs backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (CloudWatchLogs) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if req.Kind != connector.ExploreMetricNames {
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the aws-cloudwatch-logs connector", req.Kind))
	}

	client, logGroup, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}

	input := &cloudwatchlogs.DescribeMetricFiltersInput{
		LogGroupName: aws.String(logGroup),
	}
	names := map[string]struct{}{}
	paginator := cloudwatchlogs.NewDescribeMetricFiltersPaginator(client, input)
	for page := 0; paginator.HasMorePages(); page++ {
		if page >= exploreMaxPages {
			break
		}
		out, err := paginator.NextPage(ctx)
		if err != nil {
			return exploreError(err), nil
		}
		for _, filter := range out.MetricFilters {
			if filter.FilterName != nil {
				names[*filter.FilterName] = struct{}{}
			}
		}
		if req.Limit > 0 && len(names) >= req.Limit {
			break
		}
	}
	return namesResult(sortedKeys(names, req.Limit)), nil
}

// sortedKeys returns the set's keys sorted, capped at limit when positive.
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
