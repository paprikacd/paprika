// Package obsstore keeps satellite observations outside the Kubernetes API.
//
// A registration's observations are high-cardinality and change constantly,
// while Cluster.status is a single object every report rewrites whole. At 1,000
// applications that status is ~300 KB and every heartbeat pays for it. This
// package is the seam that lets the control plane put those observations in a
// backing store instead, without changing what the rest of the system asks for.
//
// It deliberately holds the report as the satellite sent it rather than a
// projected view: projection rules change with the fleet model, and a store
// that froze yesterday's projection would make a rollout of those rules a data
// migration.
package obsstore

import (
	"context"
	"sort"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"

	"github.com/benebsworth/paprika/internal/satellite"
)

// Observation is one registration's latest accepted report.
type Observation struct {
	Cluster   types.NamespacedName
	Report    *satellite.Report
	UpdatedAt time.Time
}

// Store is the provider seam. Two implementations ship: the in-memory store for
// tests and single-process use, and Redis for a shared backing store.
type Store interface {
	// Put records the latest observation for a cluster, replacing the previous.
	Put(ctx context.Context, observation Observation) error
	// List returns every recorded observation, ordered by cluster identity.
	List(ctx context.Context) ([]Observation, error)
	// Delete removes a cluster's observation.
	Delete(ctx context.Context, cluster types.NamespacedName) error
	// Name identifies the provider in metrics and logs.
	Name() string
}

// Memory is an in-process Store. It is the reference implementation and the
// default when no backing store is configured.
type Memory struct {
	mu           sync.RWMutex
	observations map[types.NamespacedName]Observation
}

// NewMemory returns an empty in-memory store.
func NewMemory() *Memory {
	return &Memory{observations: map[types.NamespacedName]Observation{}}
}

// Name implements Store.
func (m *Memory) Name() string { return "memory" }

// Put implements Store.
func (m *Memory) Put(_ context.Context, observation Observation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observations[observation.Cluster] = observation
	return nil
}

// List implements Store.
func (m *Memory) List(_ context.Context) ([]Observation, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return sortedObservations(m.observations), nil
}

// Delete implements Store.
func (m *Memory) Delete(_ context.Context, cluster types.NamespacedName) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.observations, cluster)
	return nil
}

func sortedObservations(source map[types.NamespacedName]Observation) []Observation {
	out := make([]Observation, 0, len(source))
	for _, observation := range source {
		out = append(out, observation)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Cluster.Namespace != out[j].Cluster.Namespace {
			return out[i].Cluster.Namespace < out[j].Cluster.Namespace
		}
		return out[i].Cluster.Name < out[j].Cluster.Name
	})
	return out
}
