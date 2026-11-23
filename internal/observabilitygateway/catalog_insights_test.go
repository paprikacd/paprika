package observabilitygateway

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// TestInsightsSupportMatchesRegisteredConnectors ties the catalog's Insights
// support record to the connectors that actually run: every registered
// connector has exactly one catalog entry, and every kind Insights may query
// is a data plane that connector advertises.
func TestInsightsSupportMatchesRegisteredConnectors(t *testing.T) {
	t.Parallel()

	reg := NewConnectorRegistry()
	names := reg.Names()
	require.Len(t, names, 16)
	require.Len(t, catalog.All(), len(names))

	for _, name := range names {
		conn, ok := reg.Get(name)
		require.True(t, ok, name)
		info, ok := catalog.Get(name)
		require.True(t, ok, "registered connector %q has no catalog entry", name)

		descriptor := conn.Descriptor()
		for _, kind := range info.Insights.Kinds {
			require.True(t, descriptor.CanSupply(kind), "%s: Insights kind %q is not a connector signal", name, kind)
		}
	}
}

// TestInsightsQueryableCountMatchesRegistry pins the number of types Insights
// can query against the registered set, so the two cannot drift apart silently.
func TestInsightsQueryableCountMatchesRegistry(t *testing.T) {
	t.Parallel()

	queryable := 0
	for _, info := range catalog.All() {
		if len(info.Insights.Kinds) > 0 {
			queryable++
		}
	}
	require.Equal(t, 6, queryable)
	require.Contains(t, NewConnectorRegistry().Names(), connector.ProviderMock)
}
