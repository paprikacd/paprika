// Schema exploration for Prometheus-compatible query APIs: metric names,
// label names and values (globally or constrained to one metric via series
// enumeration), and per-metric type/help/unit metadata. Every kind maps onto
// the backend's own HTTP API and returns its JSON response untouched, so
// callers learn the backend's native shapes rather than a gateway dialect.
package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Prometheus HTTP API paths serving schema enumeration.
const (
	pathLabelValues = "/api/v1/label/%s/values" // one fmt slot: the label name
	pathLabels      = "/api/v1/labels"
	pathMetadata    = "/api/v1/metadata"
	exploreMaxNames = 5000
)

// Explore enumerates one schema slice of the Prometheus-compatible backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Prometheus) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	plan, reason := exploreRequestShape(&req)
	if reason != "" {
		return exploreUnsupported(reason)
	}
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("prometheus: %w", err)
	}
	data, err := httphelp.Get(ctx, cfg.Config, plan.path, plan.params, req.Credentials)
	if err != nil {
		return exploreError(err), nil
	}
	if plan.filterNames {
		data = filterNames(data, plan.prefix, plan.limit)
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
}

// explorePlan preserves each endpoint's native response shape and bounds while
// separating request validation/routing from the cancellable HTTP operation.
type explorePlan struct {
	path        string
	params      url.Values
	prefix      string
	limit       int
	filterNames bool
}

func exploreRequestShape(req *connector.ExploreRequest) (plan explorePlan, reason string) {
	limit := httphelp.ClampLimit(req.Limit, 1000, exploreMaxNames)
	plan = explorePlan{params: url.Values{"limit": []string{strconv.Itoa(limit)}}, limit: limit, filterNames: true}
	if req.Metric != "" {
		plan.params.Set("match[]", req.Metric)
	}
	switch req.Kind {
	case connector.ExploreMetricNames:
		plan.path = fmt.Sprintf(pathLabelValues, "__name__")
		plan.prefix = req.Prefix
		setMetricNamePrefix(plan.params, req.Prefix)
		return plan, ""
	case connector.ExploreLabelNames:
		plan.path = pathLabels
		return plan, ""
	case connector.ExploreLabelValues:
		if req.Label == "" {
			return explorePlan{}, "a label name is required"
		}
		plan.path = fmt.Sprintf(pathLabelValues, url.PathEscape(req.Label))
		return plan, ""
	case connector.ExploreMetricMetadata:
		if req.Metric == "" {
			return explorePlan{}, "a metric name is required"
		}
		plan.path = pathMetadata
		plan.params = url.Values{"metric": []string{req.Metric}, "limit": []string{"1"}, "limit_per_metric": []string{strconv.Itoa(limit)}}
		plan.filterNames = false
		return plan, ""
	case connector.ExploreTraceServices:
		// Trace discovery is intentionally unsupported.
	}
	return explorePlan{}, fmt.Sprintf("exploration kind %q is not served by the prometheus connector", req.Kind)
}

func setMetricNamePrefix(params url.Values, prefix string) {
	if prefix != "" {
		params.Set("match[]", fmt.Sprintf(`{__name__=~%q}`, ".*"+regexp.QuoteMeta(prefix)+".*"))
	}
}

// filterNames applies the optional substring Prefix and entry Limit to a
// label-values response body ({"status":"success","data":[...]}), returning
// the filtered body re-encoded in the backend's own shape.
func filterNames(data json.RawMessage, prefix string, limit int) json.RawMessage {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(data, &body); err != nil {
		return data
	}
	var names []string
	if err := json.Unmarshal(body["data"], &names); err != nil {
		return data
	}
	filtered := make([]string, 0, len(names))
	for _, name := range names {
		if prefix != "" && !strings.Contains(name, prefix) {
			continue
		}
		filtered = append(filtered, name)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	items, err := json.Marshal(filtered)
	if err != nil {
		return data
	}
	body["data"] = items
	out, err := json.Marshal(body)
	if err != nil {
		return data
	}
	return out
}

// exploreUnsupported builds the result — and error — for an exploration kind
// the connector does not serve, mirroring Query's unsupported contract.
func exploreUnsupported(reason string) (*connector.ExploreResult, error) {
	return &connector.ExploreResult{
		State:  connector.StateNotAvailable,
		Reason: reason,
	}, fmt.Errorf("%w: %s", connector.ErrUnsupported, reason)
}

// exploreError converts a backend failure into its sanitized result, mirroring
// Query's queryError contract.
func exploreError(err error) *connector.ExploreResult {
	state := httphelp.ClassifyState(err)
	return &connector.ExploreResult{State: state, Reason: httphelp.ReasonFor(state)}
}
