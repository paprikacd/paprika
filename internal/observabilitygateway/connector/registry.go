package connector

import (
	"fmt"
	"sort"
	"sync"
)

// Registry holds the set of Connector implementations known at startup,
// keyed by their Descriptor().Name. Registration happens once during
// startup wiring; lookups happen afterwards, so a sync.RWMutex is the right
// tool here rather than a hot-path cache structure.
type Registry struct {
	mu     sync.RWMutex
	byName map[string]Connector
}

// NewRegistry returns an empty Registry ready for Register calls.
func NewRegistry() *Registry {
	return &Registry{byName: make(map[string]Connector)}
}

// Register adds conn to the registry under its Descriptor().Name. Two
// connectors answering to the same name is a startup configuration bug, not
// a runtime condition to resolve by picking one, so it is reported as an
// error rather than silently overwriting the earlier registration.
func (r *Registry) Register(conn Connector) error {
	name := conn.Descriptor().Name

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.byName[name]; exists {
		return fmt.Errorf("observability connector %q is already registered", name)
	}
	r.byName[name] = conn

	return nil
}

// Get looks up a registered Connector by name.
func (r *Registry) Get(name string) (Connector, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	conn, ok := r.byName[name]

	return conn, ok
}

// Names returns the names of every registered Connector, sorted for
// deterministic output.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.byName))
	for name := range r.byName {
		names = append(names, name)
	}
	sort.Strings(names)

	return names
}
