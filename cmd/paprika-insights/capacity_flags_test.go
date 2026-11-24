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
func TestResultCacheFlagDefaultsToSixteenMiBAndParses(t *testing.T) {
	t.Parallel()
	parse := func(args ...string) int {
		fs := flag.NewFlagSet("insights", flag.ContinueOnError)
		budget := registerResultCacheFlag(fs)
		require.NoError(t, fs.Parse(args))
		return *budget
	}
	require.Equal(t, insights.DefaultResultCacheMiB, parse())
	require.Equal(t, 16, parse())
	require.Equal(t, 0, parse("--result-cache-mib=0"), "zero disables the cache")
	require.Equal(t, 128, parse("--result-cache-mib=128"))
	require.EqualValues(t, -1, resultCacheBudget(insights.MaxResultCacheMiB+1), "an out of range budget is refused by NewServer")
	require.EqualValues(t, -1, resultCacheBudget(-1))
	require.EqualValues(t, 16, resultCacheBudget(16))
}

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
