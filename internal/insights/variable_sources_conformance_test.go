package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// variableSourceConformance mirrors docs/design/insights/conformance/variable-sources.json, which
// schema.ts (variable-sources-conformance.test.ts) also runs.
type variableSourceConformance struct {
	Cases []struct {
		Name      string          `json:"name"`
		Valid     bool            `json:"valid"`
		Variables json.RawMessage `json:"variables"`
	} `json:"cases"`
}

func TestVariableSourceConformanceFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/variable-sources.json")
	require.NoError(t, err)
	var fixtures variableSourceConformance
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)
	for _, entry := range fixtures.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			err := validateDashboardVariables(entry.Variables)
			require.Equal(t, entry.Valid, err == nil, "validateDashboardVariables: %v", err)
		})
	}
}
