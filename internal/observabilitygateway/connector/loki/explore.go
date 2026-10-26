// Schema exploration for Grafana Loki: the label names and label values a
// Loki tenant carries. Loki's envelope is the same {"status":"success",
// "data":[...]} shape Prometheus uses, so responses pass through untouched.
// Metric-oriented kinds are not served — LogQL selects streams by labels,
// not metric names.
package loki

import (
	"context"
	"fmt"
	"net/url"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Loki HTTP API paths serving schema enumeration.
const (
	pathLabels      = "/loki/api/v1/labels"
	pathLabelValues = "/loki/api/v1/label/%s/values" // one fmt slot: the label name
)

// Explore enumerates one schema slice of the Loki backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Loki) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	path, reason := exploreRequestPath(&req)
	if reason != "" {
		return exploreUnsupported(reason)
	}
	cfg, err := httphelp.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("loki: %w", err)
	}
	data, err := httphelp.Get(ctx, cfg, path, nil, req.Credentials)
	if err != nil {
		return exploreError(err), nil
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: data}, nil
}

// exploreRequestPath validates the exploration shape before configuration or
// network access, including explicit rejection of unsupported signal kinds.
func exploreRequestPath(req *connector.ExploreRequest) (path, reason string) {
	switch req.Kind {
	case connector.ExploreLabelNames:
		return pathLabels, ""
	case connector.ExploreLabelValues:
		if req.Label == "" {
			return "", "a label name is required"
		}
		return fmt.Sprintf(pathLabelValues, url.PathEscape(req.Label)), ""
	case connector.ExploreMetricNames, connector.ExploreMetricMetadata, connector.ExploreMetricSeries, connector.ExploreTraceServices:
		// These known exploration kinds are unsupported.
	}
	return "", fmt.Sprintf("exploration kind %q is not served by the loki connector", req.Kind)
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
