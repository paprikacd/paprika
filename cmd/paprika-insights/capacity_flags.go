package main

import (
	"flag"
	"time"

	"github.com/benebsworth/paprika/internal/insights"
)

// capacityFlags are the admission flags. A flag left at its zero value takes the
// Insights default, so a deployment that sets none of them is unchanged.
type capacityFlags struct {
	queryConcurrency   *int
	queryQueue         *int
	queryQueueWait     *time.Duration
	catalogConcurrency *int
	catalogQueue       *int
	catalogQueueWait   *time.Duration
}

func registerCapacityFlags(fs *flag.FlagSet) *capacityFlags {
	return &capacityFlags{
		queryConcurrency:   fs.Int("query-concurrency", 0, "Queries that execute at once (0 takes the default, 16)"),
		queryQueue:         fs.Int("query-queue", 0, "Queries that may wait for an execution slot (0 takes the default, 64)"),
		queryQueueWait:     fs.Duration("query-queue-wait", 0, "Longest a query waits for a slot before a 429 (0 takes the default, 2s)"),
		catalogConcurrency: fs.Int("catalog-concurrency", 0, "Shared-catalog phases at once (0 takes the default, 4)"),
		catalogQueue:       fs.Int("catalog-queue", 0, "Shared queries that may wait for a catalog phase (0 takes the default, 16)"),
		catalogQueueWait:   fs.Duration("catalog-queue-wait", 0, "Longest a shared query waits for a catalog phase before a 429 (0 takes the default, 5s)"),
	}
}

func (f *capacityFlags) capacity() insights.Capacity {
	return insights.Capacity{
		QueryConcurrency:   *f.queryConcurrency,
		QueryQueue:         *f.queryQueue,
		QueryWait:          *f.queryQueueWait,
		CatalogConcurrency: *f.catalogConcurrency,
		CatalogQueue:       *f.catalogQueue,
		CatalogWait:        *f.catalogQueueWait,
	}
}
