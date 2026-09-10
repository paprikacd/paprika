package dataprovider

import (
	"fmt"
	"sort"
	"sync"
)

// Registry holds the set of CapacitySource implementations known at
// startup, keyed by their Descriptor().Name. Registration happens once
// during startup wiring; lookups happen afterwards, so a sync.RWMutex is
// the right tool here rather than a hot-path cache structure.
type Registry struct {
	mu   sync.RWMutex
	byID map[string]CapacitySource
}

// NewRegistry returns an empty Registry ready for RegisterCapacity calls.
func NewRegistry() *Registry {
	return &Registry{byID: make(map[string]CapacitySource)}
}

// RegisterCapacity adds source to the registry under its Descriptor().Name.
// Two sources answering to the same name is a startup configuration bug, not
// a runtime condition to resolve by picking one, so it is reported as an
// error rather than silently overwriting the earlier registration.
func (r *Registry) RegisterCapacity(source CapacitySource) error {
	name := source.Descriptor().Name

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.byID[name]; exists {
		return fmt.Errorf("capacity provider %q is already registered", name)
	}
	r.byID[name] = source

	return nil
}

// Capacity looks up a registered CapacitySource by name.
func (r *Registry) Capacity(name string) (CapacitySource, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	source, ok := r.byID[name]

	return source, ok
}

// CapacityNames returns the names of every registered CapacitySource, sorted
// for deterministic output.
func (r *Registry) CapacityNames() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.byID))
	for name := range r.byID {
		names = append(names, name)
	}
	sort.Strings(names)

	return names
}
