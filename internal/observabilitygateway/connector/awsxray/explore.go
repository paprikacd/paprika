// Schema exploration for AWS X-Ray: the service names the trace graph knows,
// enumerated through the GetServiceGraph API over a fixed trailing window.
// GetServiceGraph requires both time bounds, so the connector always passes
// an absolute window — the trailing thirty minutes, wide enough to catch
// every service a live system touches yet bounded enough to keep the call
// cheap. The API paginates by NextToken with no page-size parameter and no
// SDK paginator, so the connector walks the token itself, capped at
// exploreMaxPages pages, unions Services[].Name client-side, and wraps the
// result in the {"status":"success","data":[...]} envelope.
//
// X-Ray has no metric or label vocabulary — traces carry arbitrary
// annotations and metadata rather than an enumerable schema — so only
// trace_services is served.
package awsxray

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/xray"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/awscommon"
)

// exploreWindow is the trailing window GetServiceGraph is always asked
// about: every service a live system touches appears inside half an hour,
// and a bounded window keeps the graph computation cheap.
const exploreWindow = 30 * time.Minute

// exploreMaxPages bounds the GetServiceGraph walk so a busy account cannot
// paginate indefinitely.
const exploreMaxPages = 20

// XRay satisfies connector.Explorer: GetServiceGraph enumerates the service
// names the trace graph knows.
var _ connector.Explorer = XRay{}

// Explore enumerates one schema slice of the X-Ray backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (XRay) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if req.Kind != connector.ExploreTraceServices {
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the aws-xray connector", req.Kind))
	}

	client, err := setup(ctx, req.Config, req.Credentials)
	if err != nil {
		return nil, err
	}
	return exploreTraceServices(ctx, client, req.Limit), nil
}

// exploreTraceServices unions Services[].Name across GetServiceGraph pages
// over the trailing exploreWindow.
func exploreTraceServices(ctx context.Context, client *xray.Client, limit int) *connector.ExploreResult {
	end := time.Now()
	start := end.Add(-exploreWindow)
	names := map[string]struct{}{}
	input := &xray.GetServiceGraphInput{
		StartTime: aws.Time(start),
		EndTime:   aws.Time(end),
	}
	for page := 0; page < exploreMaxPages; page++ {
		out, err := client.GetServiceGraph(ctx, input)
		if err != nil {
			return exploreError(fmt.Errorf("getting the service graph: %w", err))
		}
		for i := range out.Services {
			if name := out.Services[i].Name; name != nil && *name != "" {
				names[*name] = struct{}{}
			}
		}
		if limit > 0 && len(names) >= limit {
			break
		}
		if out.NextToken == nil || *out.NextToken == "" {
			break
		}
		input.NextToken = out.NextToken
	}
	return namesResult(sortedKeys(names, limit))
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
