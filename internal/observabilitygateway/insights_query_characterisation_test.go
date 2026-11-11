package observabilitygateway

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The text golden was captured from the base synopsis of the same structured output
// that the insights characterisation pins. Input without an attention summary must
// keep producing exactly this synopsis.
func TestDashboardQueryTextCharacterisesBaseSynopsisWithoutAttention(t *testing.T) {
	structured, err := os.ReadFile("testdata/dashboard_query_base.json")
	require.NoError(t, err)
	golden, err := os.ReadFile("testdata/dashboard_query_base.txt")
	require.NoError(t, err)
	text, err := dashboardQueryText(json.RawMessage(structured))
	require.NoError(t, err)
	require.Equal(t, string(golden), text)
}
