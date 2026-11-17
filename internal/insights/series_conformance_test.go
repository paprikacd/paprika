package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The series colour rule fixtures are also run through Zod (ui series-rules-conformance.test.ts). Every case must
// reach the same verdict on validateDashboard and on the embedded dashboard JSON Schema.
func TestSeriesColorRuleConformanceFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/series-rules.json")
	require.NoError(t, err)
	var fixtures struct {
		Roles []string `json:"roles"`
		Cases []struct {
			Name          string          `json:"name"`
			Valid         bool            `json:"valid"`
			SeriesColor   json.RawMessage `json:"seriesColors"`
			JSONSchemaGap string          `json:"jsonSchemaGap"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)
	require.Equal(t, seriesColorRoles, fixtures.Roles)
	schema := compileEmbeddedDashboardSchema(t)
	for _, entry := range fixtures.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			document := extendedDashboard(`"type":"timeseries","options":{"seriesColors":`+string(entry.SeriesColor)+`}`, "")
			err := validateDashboard("demo", document)
			require.Equal(t, entry.Valid, err == nil, "validateDashboard: %v", err)

			var decoded any
			require.NoError(t, json.Unmarshal(document, &decoded))
			jsonErr := schema.Validate(decoded)
			if entry.JSONSchemaGap != "" {
				// JSON Schema cannot express unique label and value pairs. Pin the gap, so it stays visible.
				require.Equal(t, "uniqueness", entry.JSONSchemaGap)
				require.NoError(t, jsonErr, "the embedded schema is expected to accept a %s case", entry.JSONSchemaGap)
				return
			}
			require.Equal(t, entry.Valid, jsonErr == nil, "embedded JSON Schema: %v", jsonErr)
		})
	}
}

// The series colour mode cases in colors.json run through validateDashboard and the embedded dashboard JSON Schema,
// with the same verdict as Zod (ui colors-conformance.test.ts). A document without the mode stays valid.
func TestSeriesColorModeConformanceFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/colors.json")
	require.NoError(t, err)
	var fixtures struct {
		Modes []string `json:"modes"`
		Cases []struct {
			Name    string          `json:"name"`
			Valid   bool            `json:"valid"`
			Options json.RawMessage `json:"options"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)
	require.Equal(t, []string{"name", "index"}, fixtures.Modes)
	schema := compileEmbeddedDashboardSchema(t)
	for _, entry := range fixtures.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			document := extendedDashboard(`"type":"timeseries","options":`+string(entry.Options), "")
			err := validateDashboard("demo", document)
			require.Equal(t, entry.Valid, err == nil, "validateDashboard: %v", err)

			var decoded any
			require.NoError(t, json.Unmarshal(document, &decoded))
			jsonErr := schema.Validate(decoded)
			require.Equal(t, entry.Valid, jsonErr == nil, "embedded JSON Schema: %v", jsonErr)
		})
	}
}
