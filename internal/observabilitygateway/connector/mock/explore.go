// Schema exploration for the mock connector: deterministic catalog data for
// every exploration kind, so demos and e2e exercise the same wire shapes the
// real backends return without network egress. Data is fixed (not seeded per
// query) — exploration answers "what exists", and a stable catalog is more
// useful for that than a per-query synthetic spread.
package mock

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// Mock catalog fixtures. The metric set mirrors what the query payload
// generator produces, so a caller can explore the mock and then query what
// it found.
var (
	mockMetricNames = []string{
		"mock_http_requests_total",
		"mock_http_request_duration_seconds_bucket",
		"mock_http_request_duration_seconds_count",
		"mock_http_request_duration_seconds_sum",
		"mock_cpu_usage_seconds_total",
		"mock_memory_usage_bytes",
	}
	mockLabelNames = []string{"app", "instance", "job", "level", "namespace", "pod"}
	mockServices   = []string{"mock-svc-0", "mock-svc-1", "mock-svc-2", "mock-svc-3"}
)

// Explore answers one schema-enumeration request from the fixed catalog.
// Latency and failure knobs do not apply: exploration is metadata about the
// mock itself, not backend work.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Mock) Explore(_ context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	if _, err := parseConfig(req.Config); err != nil {
		return nil, fmt.Errorf("mock: %w", err)
	}

	switch req.Kind {
	case connector.ExploreMetricNames:
		return exploreResult(mockMetricNames, req.Prefix, req.Limit), nil
	case connector.ExploreLabelNames:
		return exploreResult(mockLabelNames, req.Prefix, req.Limit), nil
	case connector.ExploreLabelValues:
		if req.Label == "" {
			return exploreUnsupported("a label name is required")
		}
		values := mockLabelValues(req.Label)
		return exploreResult(values, req.Prefix, req.Limit), nil
	case connector.ExploreMetricMetadata:
		if req.Metric == "" {
			return exploreUnsupported("a metric name is required")
		}
		return exploreMetadata(req.Metric)
	case connector.ExploreTraceServices:
		return exploreResult(mockServices, req.Prefix, req.Limit), nil
	default:
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the mock connector", req.Kind))
	}
}

// mockLabelValues fabricates plausible values for a label. Well-known labels
// answer from a small fixed set; anything else gets one deterministic value.
func mockLabelValues(label string) []string {
	switch label {
	case "app":
		return []string{"mock-app", "mock-worker"}
	case "instance":
		return []string{"mock-0:8080", "mock-1:8080"}
	case "job":
		return []string{"mock"}
	case "level":
		return []string{"debug", "error", "info", "warn"}
	case "namespace":
		return []string{"observability"}
	case "pod":
		return []string{"mock-0", "mock-1"}
	default:
		return []string{"mock-value"}
	}
}

// exploreMetadata describes one mock metric in the shape Prometheus'
// /api/v1/metadata answers: {"status":"success","data":{<name>:[{type,help,unit}]}}.
func exploreMetadata(metric string) (*connector.ExploreResult, error) {
	entry := map[string]string{"type": "gauge", "help": "Synthetic mock metric.", "unit": ""}
	switch {
	case strings.HasSuffix(metric, "_total"):
		entry["type"] = "counter"
	case strings.HasSuffix(metric, "_bucket") || strings.HasSuffix(metric, "_sum") || strings.HasSuffix(metric, "_count"):
		entry["type"] = "histogram"
	case strings.HasSuffix(metric, "_seconds"):
		entry["unit"] = "seconds"
	case strings.HasSuffix(metric, "_bytes"):
		entry["unit"] = "bytes"
	}
	data, err := json.Marshal(struct {
		Status string                         `json:"status"`
		Data   map[string][]map[string]string `json:"data"`
	}{Status: "success", Data: map[string][]map[string]string{metric: {entry}}})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}, nil
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
}

// exploreResult applies the optional substring Prefix and entry Limit, then
// wraps the entries in the {"status":"success","data":[...]} envelope the
// prometheus and loki exploration endpoints return.
func exploreResult(items []string, prefix string, limit int) *connector.ExploreResult {
	filtered := make([]string, 0, len(items))
	for _, item := range items {
		if prefix != "" && !strings.Contains(item, prefix) {
			continue
		}
		filtered = append(filtered, item)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	data, err := json.Marshal(struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}{Status: "success", Data: filtered})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}
}

func exploreUnsupported(reason string) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}
