package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// The shared fixtures in docs/design/insights/conformance are also run through Zod (ui schema-conformance.test.ts).
// Every case must reach the same verdict on the Go validator and on the embedded dashboard JSON Schema.
func TestThresholdConformanceFixtures(t *testing.T) {
	fixtures := readConformanceCases(t, "../../docs/design/insights/conformance/thresholds.json")
	require.NotEmpty(t, fixtures.Cases)
	schema := compileEmbeddedDashboardSchema(t)
	for _, entry := range fixtures.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			document := extendedDashboard(`"type":"timeseries","options":{"thresholds":`+string(entry.Thresholds)+`}`, "")
			err := validateDashboard("demo", document)
			require.Equal(t, entry.Valid, err == nil, "validateDashboard: %v", err)

			var decoded any
			require.NoError(t, json.Unmarshal(document, &decoded))
			jsonErr := schema.Validate(decoded)
			if entry.JSONSchemaGap != "" {
				// JSON Schema has no keyword for strictly increasing array values. Pin the known gap, so it
				// stays visible rather than silently widening agreement.
				require.Contains(t, []string{"ordering", "string-length"}, entry.JSONSchemaGap)
				require.NoError(t, jsonErr, "the embedded schema is expected to accept a %s case", entry.JSONSchemaGap)
				return
			}
			require.Equal(t, entry.Valid, jsonErr == nil, "embedded JSON Schema: %v", jsonErr)
		})
	}
}

// The Go status list is the third copy of the vocabulary, after Zod and the published tokens.
func TestStatusLevelsMatchPublishedTokens(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/status-tokens.json")
	require.NoError(t, err)
	var tokens struct {
		Levels []string `json:"levels"`
	}
	require.NoError(t, json.Unmarshal(raw, &tokens))
	require.Equal(t, statusLevels, tokens.Levels)
}

type conformanceCase struct {
	Name       string          `json:"name"`
	Valid      bool            `json:"valid"`
	Thresholds json.RawMessage `json:"thresholds"`
	// JSONSchemaGap names a rule the published JSON Schema cannot express (ordering or string-length). The schema must accept such a case.
	JSONSchemaGap string `json:"jsonSchemaGap"`
}

func readConformanceCases(t *testing.T, path string) struct {
	Cases []conformanceCase `json:"cases"`
} {
	t.Helper()
	raw, err := os.ReadFile(path) //nolint:gosec // Fixed repository fixture path.
	require.NoError(t, err)
	var fixtures struct {
		Cases []conformanceCase `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	return fixtures
}

func compileEmbeddedDashboardSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	source, err := insightsschema.Document("dashboard")
	require.NoError(t, err)
	var raw any
	require.NoError(t, json.Unmarshal(source, &raw))
	compiler := jsonschema.NewCompiler()
	const url = "https://example.test/dashboard.schema.json"
	require.NoError(t, compiler.AddResource(url, raw))
	schema, err := compiler.Compile(url)
	require.NoError(t, err)
	return schema
}
