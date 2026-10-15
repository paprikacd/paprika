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
	"sort"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Prometheus HTTP API paths serving schema enumeration.
const (
	pathLabelValues  = "/api/v1/label/%s/values" // one fmt slot: the label name
	pathLabels       = "/api/v1/labels"
	pathSeries       = "/api/v1/series"
	pathMetadata     = "/api/v1/metadata"
	exploreMaxSeries = 5000 // series entries read when unioning labels for one metric
)

// Explore enumerates one schema slice of the Prometheus-compatible backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Prometheus) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	// Shape requirements are checked before configuration, mirroring Query:
	// a missing label or metric names a caller bug whatever the config says.
	switch req.Kind {
	case connector.ExploreMetricNames, connector.ExploreLabelNames:
	case connector.ExploreLabelValues:
		if req.Label == "" {
			return exploreUnsupported("a label name is required")
		}
	case connector.ExploreMetricMetadata:
		if req.Metric == "" {
			return exploreUnsupported("a metric name is required")
		}
	default:
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the prometheus connector", req.Kind))
	}

	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("prometheus: %w", err)
	}

	switch req.Kind {
	case connector.ExploreMetricNames:
		data, err := httphelp.Get(ctx, cfg.Config, fmt.Sprintf(pathLabelValues, "__name__"), nil, req.Credentials)
		if err != nil {
			return exploreError(err), nil
		}
		return &connector.ExploreResult{State: connector.StateOK, Data: filterNames(data, req.Prefix, req.Limit)}, nil

	case connector.ExploreLabelNames:
		if req.Metric == "" {
			data, err := httphelp.Get(ctx, cfg.Config, pathLabels, nil, req.Credentials)
			if err != nil {
				return exploreError(err), nil
			}
			return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
		}
		keys, err := seriesLabelUnion(ctx, cfg, req, true)
		if err != nil {
			return exploreError(err), nil
		}
		return namesResult(keys, req.Limit), nil

	case connector.ExploreLabelValues:
		if req.Metric == "" {
			data, err := httphelp.Get(ctx, cfg.Config, fmt.Sprintf(pathLabelValues, url.PathEscape(req.Label)), nil, req.Credentials)
			if err != nil {
				return exploreError(err), nil
			}
			return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
		}
		values, err := seriesLabelUnion(ctx, cfg, req, false)
		if err != nil {
			return exploreError(err), nil
		}
		return namesResult(values, req.Limit), nil

	case connector.ExploreMetricMetadata:
		if req.Metric == "" {
			return exploreUnsupported("a metric name is required")
		}
		data, err := httphelp.Get(ctx, cfg.Config, pathMetadata, url.Values{"metric": []string{req.Metric}}, req.Credentials)
		if err != nil {
			return exploreError(err), nil
		}
		return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil

	default:
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the prometheus connector", req.Kind))
	}
}

// seriesLabelUnion enumerates the series of req.Metric and unions either the
// label names (names=true) or the values of req.Label (names=false) across
// them. The series API is the only label-values source constrained by a
// metric selector; its response shape is {"data":[{<label>:<value>,...}]}.
func seriesLabelUnion(ctx context.Context, cfg prometheusConfig, req connector.ExploreRequest, names bool) ([]string, error) {
	params := url.Values{"match[]": []string{req.Metric}}
	data, err := httphelp.Get(ctx, cfg.Config, pathSeries, params, req.Credentials)
	if err != nil {
		return nil, err
	}
	var body struct {
		Data []map[string]string `json:"data"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, fmt.Errorf("decoding series response: %w", err)
	}
	set := map[string]struct{}{}
	for i, series := range body.Data {
		if i >= exploreMaxSeries {
			break
		}
		if names {
			for key := range series {
				set[key] = struct{}{}
			}
			continue
		}
		if value, ok := series[req.Label]; ok {
			set[value] = struct{}{}
		}
	}
	return sortedKeys(set), nil
}

// filterNames applies the optional substring Prefix and entry Limit to a
// label-values response body ({"status":"success","data":[...]}), returning
// the filtered body re-encoded in the backend's own shape.
func filterNames(data json.RawMessage, prefix string, limit int) json.RawMessage {
	var body struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return data
	}
	filtered := make([]string, 0, len(body.Data))
	for _, name := range body.Data {
		if prefix != "" && !strings.Contains(name, prefix) {
			continue
		}
		filtered = append(filtered, name)
		if limit > 0 && len(filtered) >= limit {
			break
		}
	}
	out, err := json.Marshal(struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}{Status: body.Status, Data: filtered})
	if err != nil {
		return data
	}
	return out
}

// namesResult wraps a sorted string set in the same {"status":"success",
// "data":[...]} shape the backend's label-value endpoints return, so every
// exploration kind answers in one recognizable envelope.
func namesResult(items []string, limit int) *connector.ExploreResult {
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	data, err := json.Marshal(struct {
		Status string   `json:"status"`
		Data   []string `json:"data"`
	}{Status: "success", Data: items})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}
}

func sortedKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
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
