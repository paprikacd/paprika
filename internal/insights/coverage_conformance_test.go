package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// coverageConformance mirrors docs/design/insights/conformance/coverage.json, which
// schema.ts (coverage-conformance.test.ts) also runs.
type coverageConformance struct {
	Cases []struct {
		Name          string          `json:"name"`
		Valid         bool            `json:"valid"`
		JSONSchemaGap string          `json:"jsonSchemaGap"`
		Document      json.RawMessage `json:"document"`
	} `json:"cases"`
}

func TestCoverageConformanceFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/coverage.json")
	require.NoError(t, err)
	var fixtures coverageConformance
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)
	schema := compileEmbeddedDashboardSchema(t)
	for _, entry := range fixtures.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			err := validateDashboard("demo", Dashboard(entry.Document))
			require.Equal(t, entry.Valid, err == nil, "validateDashboard: %v", err)

			var decoded any
			require.NoError(t, json.Unmarshal(entry.Document, &decoded))
			jsonErr := schema.Validate(decoded)
			if entry.JSONSchemaGap != "" {
				// JSON Schema cannot check a variable or widget reference, so it accepts the case.
				require.Equal(t, "reference", entry.JSONSchemaGap)
				require.NoError(t, jsonErr, "the embedded schema is expected to accept a %s case", entry.JSONSchemaGap)
				return
			}
			require.Equal(t, entry.Valid, jsonErr == nil, "embedded JSON Schema: %v", jsonErr)
		})
	}
}
