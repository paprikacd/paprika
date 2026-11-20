package main

import (
	"flag"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights"
)

func parseCapacityFlags(t *testing.T, args ...string) insights.Capacity {
	t.Helper()
	fs := flag.NewFlagSet("insights", flag.ContinueOnError)
	flags := registerCapacityFlags(fs)
	require.NoError(t, fs.Parse(args))
	return flags.capacity()
}

// Without flags the capacity is zero everywhere, so Insights applies its defaults.
func TestCapacityFlagsDefaultToZero(t *testing.T) {
	require.Equal(t, insights.Capacity{}, parseCapacityFlags(t))
}

func TestCapacityFlagsSetDashboardParallelism(t *testing.T) {
	require.Equal(t, insights.Capacity{DashboardQueryParallelism: 1}, parseCapacityFlags(t, "--dashboard-query-parallelism=1"))
	require.Equal(t, insights.Capacity{DashboardQueryParallelism: 4}, parseCapacityFlags(t, "--dashboard-query-parallelism=4"))
}

func TestCapacityFlagsSetEveryPool(t *testing.T) {
	require.Equal(t, insights.Capacity{QueryConcurrency: 8, QueryQueue: 32, QueryWait: 3 * time.Second, CatalogConcurrency: 2, CatalogQueue: 6, CatalogWait: 4 * time.Second},
		parseCapacityFlags(t, "--query-concurrency=8", "--query-queue=32", "--query-queue-wait=3s", "--catalog-concurrency=2", "--catalog-queue=6", "--catalog-queue-wait=4s"))
}
