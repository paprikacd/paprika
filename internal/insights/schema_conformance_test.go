package insights

import (
	"encoding/json"
	"math"
	"os"
	"strings"
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
				require.Equal(t, "ordering", entry.JSONSchemaGap)
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
	// JSONSchemaGap names the rule the published JSON Schema cannot express: strictly increasing values. The schema must accept such a case.
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

// A field of the wrong JSON type gets its own message, not the value-order message.
func TestThresholdFieldTypeErrorsNameTheType(t *testing.T) {
	for _, raw := range []string{
		`{"value":0,"status":5}`,
		`{"value":0,"color":5}`,
		`{"value":0,"status":"ok","label":5}`,
		`{"value":"0","status":"ok"}`,
	} {
		_, err := validateWidgetThreshold(json.RawMessage(raw), math.Inf(-1))
		require.EqualError(t, err, "threshold value must be a number, and status, color and label must be strings", raw)
	}
	_, err := validateWidgetThreshold(json.RawMessage(`{"value":1,"status":"ok"}`), 1)
	require.EqualError(t, err, "thresholds require increasing finite values")
}

// When several options are invalid at once, the reported field must be the same on every call. Map iteration order
// is random in Go, so these two cases used to vary between calls.
func TestOptionErrorsAreDeterministicWhenSeveralFieldsAreInvalid(t *testing.T) {
	long, _ := json.Marshal(strings.Repeat("x", 121))
	tooltip := map[string]json.RawMessage{"tooltipTitle": long, "tooltipValueLabel": json.RawMessage(`"` + strings.Repeat("y", 81) + `"`)}
	appearance := map[string]json.RawMessage{"sparklinePlacement": json.RawMessage(`"top"`), "statIcon": json.RawMessage(`"rocket"`)}
	for i := 0; i < 200; i++ {
		require.EqualError(t, validateWidgetTooltipPresentation(tooltip), "tooltipTitle must be a string of at most 120 characters")
		require.EqualError(t, validateWidgetAppearance(appearance), "invalid sparklinePlacement")
	}
}
