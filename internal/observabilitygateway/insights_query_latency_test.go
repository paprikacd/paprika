package observabilitygateway

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// latencyMs is optional and additive: a result without it stays valid, and a result with it validates
// only as a non-negative whole number of milliseconds. Old Insights builds omit it, so the schema must
// accept both directions.
func TestDashboardSignalLatencyValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	var document map[string]any
	require.NoError(t, json.Unmarshal(mustReadDashboardTestdata(t, "dashboard_query_base.json"), &document))
	signals, ok := document["signals"].([]any)
	require.True(t, ok)
	signal, ok := signals[0].(map[string]any)
	require.True(t, ok)
	require.NoError(t, resolved.Validate(document), "a signal without latencyMs stays valid")

	signal["latencyMs"] = 0
	require.NoError(t, resolved.Validate(document), "zero is a valid latency")
	signal["latencyMs"] = 1234
	require.NoError(t, resolved.Validate(document))
	for _, invalid := range []any{-1, 1.5, "12"} {
		signal["latencyMs"] = invalid
		require.Error(t, resolved.Validate(document), "latencyMs %v must be refused", invalid)
	}
}
