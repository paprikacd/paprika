// Schema exploration for the Vultr monitoring connector. The metric catalog
// and the series label set are static — the v2 API exposes only the
// bandwidth endpoints — so metric_names and label_names answer from fixed
// lists, while label_values enumerates the live instance list (GET
// /v2/instances) for one of the known instance fields. metric_metadata
// answers from the same static catalog in the shape Prometheus'
// /api/v1/metadata uses, so a caller can treat the description uniformly.
package vultrmonitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// metadataCatalog describes each static metric: the type/help/unit triple
// the metric_metadata kind answers with.
var metadataCatalog = map[string]struct {
	typ  string
	help string
	unit string
}{
	MetricAccountBandwidth: {
		typ:  "gauge",
		help: "Account bandwidth for the previous, current-to-date and projected billing periods, in GB, with overage.",
		unit: "GB",
	},
	MetricInstanceIncomingBytes: {
		typ:  "counter",
		help: "Per-instance incoming network bytes per day over the current billing period, assembled across every cloud-compute instance.",
		unit: "bytes",
	},
	MetricInstanceOutgoingBytes: {
		typ:  "counter",
		help: "Per-instance outgoing network bytes per day over the current billing period, assembled across every cloud-compute instance.",
		unit: "bytes",
	},
}

// Explore enumerates one schema slice of the Vultr monitoring backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (VultrMonitoring) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	supported := req.Kind == connector.ExploreMetricNames ||
		req.Kind == connector.ExploreLabelNames ||
		req.Kind == connector.ExploreLabelValues ||
		req.Kind == connector.ExploreMetricMetadata
	if !supported {
		return exploreUnsupported(fmt.Sprintf("exploration kind %q is not served by the vultr-monitoring connector", req.Kind))
	}
	if req.Kind == connector.ExploreLabelValues && req.Label == "" {
		return exploreUnsupported("a label name is required")
	}
	if req.Kind == connector.ExploreMetricMetadata && req.Metric == "" {
		return exploreUnsupported("a metric name is required")
	}

	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("vultr-monitoring: %w", err)
	}

	switch req.Kind {
	case connector.ExploreMetricNames:
		return stringListResult(metricCatalog, req.Prefix, req.Limit), nil

	case connector.ExploreLabelNames:
		return stringListResult(instanceLabels, req.Prefix, req.Limit), nil

	case connector.ExploreLabelValues:
		if len(req.Credentials) == 0 {
			return notConfiguredExplore(), nil
		}
		if !knownInstanceLabel(req.Label) {
			return &connector.ExploreResult{State: connector.StateNotAvailable, Reason: reasonNotEnumerated}, nil
		}
		instances, err := listInstances(ctx, cfg, req.Credentials)
		if err != nil {
			return exploreError(err), nil
		}
		return stringListResult(instanceFieldValues(instances, req.Label), req.Prefix, req.Limit), nil

	default: // ExploreMetricMetadata — requirement checked above.
		entry, ok := metadataCatalog[req.Metric]
		if !ok {
			return &connector.ExploreResult{
				State:  connector.StateNotAvailable,
				Reason: fmt.Sprintf("metric %q is not served by the vultr-monitoring connector", req.Metric),
			}, nil
		}
		return metadataResult(req.Metric, entry)
	}
}

// knownInstanceLabel reports whether label is one of the instance fields
// the connector surfaces.
func knownInstanceLabel(label string) bool {
	for _, known := range instanceLabels {
		if known == label {
			return true
		}
	}
	return false
}

// instanceFieldValues unions one instance field across the fleet.
func instanceFieldValues(instances []instance, field string) []string {
	set := map[string]struct{}{}
	for i := range instances {
		var value string
		switch field {
		case "instance_id":
			value = instances[i].ID
		case "label":
			value = instances[i].Label
		case "region":
			value = instances[i].Region
		default:
			value = instances[i].Status
		}
		if value != "" {
			set[value] = struct{}{}
		}
	}
	values := make([]string, 0, len(set))
	for value := range set {
		values = append(values, value)
	}
	sort.Strings(values)
	return values
}

// stringListResult applies the optional substring Prefix and entry Limit,
// then wraps the entries in the {"status":"success","data":[...]} envelope
// the prometheus and loki exploration endpoints return.
func stringListResult(items []string, prefix string, limit int) *connector.ExploreResult {
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

// metadataResult answers one metric's description in the shape Prometheus'
// /api/v1/metadata returns: {"status":"success","data":{<name>:[{type,help,unit}]}}.
func metadataResult(metric string, entry struct {
	typ  string
	help string
	unit string
}) (*connector.ExploreResult, error) {
	data, err := json.Marshal(struct {
		Status string                       `json:"status"`
		Data   map[string][]map[string]string `json:"data"`
	}{Status: "success", Data: map[string][]map[string]string{
		metric: {{"type": entry.typ, "help": entry.help, "unit": entry.unit}},
	}})
	if err != nil {
		return &connector.ExploreResult{State: connector.StateError, Reason: "encoding the exploration result failed"}, nil
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
}

func notConfiguredExplore() *connector.ExploreResult {
	return &connector.ExploreResult{State: connector.StateNotConfigured, Reason: reasonCredentials}
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
