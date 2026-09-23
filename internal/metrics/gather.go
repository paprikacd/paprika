package metrics

import (
	"fmt"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// PrefixGatherer wraps a prometheus.Gatherer and emits only the metric
// families whose names carry one of the given prefixes.
//
// It exists to merge a second registry (component-base's legacyregistry,
// which client-go's rest_client_* metrics land in) into a promhttp endpoint
// that already serves a registry carrying go_*/process_* collectors —
// prometheus.Gatherers fails the whole scrape when two registries collect
// the same family, so the duplicate-prone families are filtered out here
// rather than merged wholesale.
func PrefixGatherer(inner prometheus.Gatherer, prefixes ...string) prometheus.Gatherer {
	return &prefixGatherer{inner: inner, prefixes: prefixes}
}

type prefixGatherer struct {
	inner    prometheus.Gatherer
	prefixes []string
}

func (g *prefixGatherer) Gather() ([]*dto.MetricFamily, error) {
	families, err := g.inner.Gather()
	if err != nil {
		return nil, fmt.Errorf("gather filtered metrics: %w", err)
	}
	kept := families[:0]
	for _, family := range families {
		for _, prefix := range g.prefixes {
			if strings.HasPrefix(family.GetName(), prefix) {
				kept = append(kept, family)
				break
			}
		}
	}
	return kept, nil
}
