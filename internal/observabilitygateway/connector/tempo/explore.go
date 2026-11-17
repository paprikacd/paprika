// Schema exploration for Grafana Tempo: the search tags the backend knows,
// the values each tag takes, and the service names spans carry. Tempo has no
// standalone service-listing endpoint, so service discovery reads the values
// of the well-known service.name resource attribute; responses pass through
// in Tempo's own envelope shapes.
package tempo

import (
	"context"
	"fmt"
	"net/url"
	"strconv"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// Tempo HTTP API paths serving schema enumeration, and the resource
// attribute carrying a span's service name.
const (
	pathSearchTags     = "/api/search/tags"
	pathSearchTagValue = "/api/search/tag/%s/values" // one fmt slot: the tag name
	serviceNameTag     = "service.name"
)

// Explore enumerates one schema slice of the Tempo backend.
//
//nolint:gocritic // ExploreRequest travels by value by design — per-call state belongs in the request, not the connector (clusterprovider contract).
func (Tempo) Explore(ctx context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	path, reason := exploreRequestPath(&req)
	if reason != "" {
		return exploreUnsupported(reason)
	}
	cfg, err := httphelp.ParseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("tempo: %w", err)
	}
	limit := httphelp.ClampLimit(req.Limit, 100, 1000)
	params := url.Values{"limit": []string{strconv.Itoa(limit + 1)}}
	if !req.Range.Start.IsZero() {
		params.Set("start", strconv.FormatInt(req.Range.Start.Unix(), 10))
	}
	if !req.Range.End.IsZero() {
		params.Set("end", strconv.FormatInt(req.Range.End.Unix(), 10))
	}
	data, err := httphelp.Get(ctx, cfg, path, params, req.Credentials)
	if err != nil {
		return exploreError(err), nil
	}
	key := "tagValues"
	if req.Kind == connector.ExploreLabelNames {
		key = "tagNames"
	}
	return &connector.ExploreResult{State: connector.StateOK, Data: httphelp.LimitDiscoveryArray(data, key, limit)}, nil
}

// exploreRequestPath validates the exploration shape before configuration or
// network access, including explicit rejection of unsupported signal kinds.
func exploreRequestPath(req *connector.ExploreRequest) (path, reason string) {
	switch req.Kind {
	case connector.ExploreTraceServices:
		return fmt.Sprintf(pathSearchTagValue, serviceNameTag), ""
	case connector.ExploreLabelNames:
		return pathSearchTags, ""
	case connector.ExploreLabelValues:
		if req.Label == "" {
			return "", "a tag name is required"
		}
		return fmt.Sprintf(pathSearchTagValue, url.PathEscape(req.Label)), ""
	case connector.ExploreMetricNames, connector.ExploreMetricMetadata, connector.ExploreMetricSeries:
		// These known exploration kinds are unsupported.
	}
	return "", fmt.Sprintf("exploration kind %q is not served by the tempo connector", req.Kind)
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
