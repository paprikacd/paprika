package insights

import (
	"errors"
	"fmt"
	"time"
)

// Capacity sizes Insights' admission pools: the queries that execute, the
// waiters behind them and how long a waiter holds its place, and the same three
// for the shared-catalog phases. A zero field takes its default, so a config
// that sets none of them behaves as Insights always has.
type Capacity struct {
	QueryConcurrency   int           `json:"queryConcurrency,omitempty"`
	QueryQueue         int           `json:"queryQueue,omitempty"`
	QueryWait          time.Duration `json:"queryWait,omitempty"`
	CatalogConcurrency int           `json:"catalogConcurrency,omitempty"`
	CatalogQueue       int           `json:"catalogQueue,omitempty"`
	CatalogWait        time.Duration `json:"catalogWait,omitempty"`
}

// The defaults. They are the values the admission pools had before they were
// configurable.
const (
	defaultQueryConcurrency   = 16
	defaultQueryQueue         = 64
	defaultQueryWait          = 2 * time.Second
	defaultCatalogConcurrency = 4
	defaultCatalogQueue       = 16
	defaultCatalogWait        = 5 * time.Second
	// maxCapacityCount bounds each count, so a typo cannot allocate a large pool.
	maxCapacityCount = 1024
)

// resolved returns the effective capacity of a config's optional capacity: the
// defaults when it is nil, and otherwise c with each zero field defaulted.
func (c *Capacity) resolved() Capacity {
	if c == nil {
		return Capacity{}.withDefaults()
	}
	return c.withDefaults()
}

// withDefaults returns c with every zero field set to its default.
func (c Capacity) withDefaults() Capacity {
	if c.QueryConcurrency == 0 {
		c.QueryConcurrency = defaultQueryConcurrency
	}
	if c.QueryQueue == 0 {
		c.QueryQueue = defaultQueryQueue
	}
	if c.QueryWait == 0 {
		c.QueryWait = defaultQueryWait
	}
	if c.CatalogConcurrency == 0 {
		c.CatalogConcurrency = defaultCatalogConcurrency
	}
	if c.CatalogQueue == 0 {
		c.CatalogQueue = defaultCatalogQueue
	}
	if c.CatalogWait == 0 {
		c.CatalogWait = defaultCatalogWait
	}
	return c
}

// validate checks the effective capacity. Counts are between 1 and 1024 and
// waits are at least a millisecond. A shared query spends its catalog wait and
// its query wait before its data call, so both together must fit inside the
// query budget.
func (c Capacity) validate(budget time.Duration) error {
	for _, count := range []struct {
		name  string
		value int
	}{
		{"query concurrency", c.QueryConcurrency}, {"query queue", c.QueryQueue},
		{"catalog concurrency", c.CatalogConcurrency}, {"catalog queue", c.CatalogQueue},
	} {
		if count.value < 1 || count.value > maxCapacityCount {
			return fmt.Errorf("insights %s must be between 1 and %d", count.name, maxCapacityCount)
		}
	}
	for _, wait := range []struct {
		name  string
		value time.Duration
	}{{"query wait", c.QueryWait}, {"catalog wait", c.CatalogWait}} {
		if wait.value < time.Millisecond {
			return fmt.Errorf("insights %s must be at least 1ms", wait.name)
		}
	}
	if c.CatalogWait+c.QueryWait >= budget {
		return errors.New("insights catalog wait plus query wait must be less than the query budget")
	}
	return nil
}

// Capacity returns the effective admission capacity, with defaults applied.
func (s *Server) Capacity() Capacity {
	return s.capacity
}
