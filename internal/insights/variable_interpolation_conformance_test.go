package insights

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

// interpolationConformance mirrors docs/design/insights/conformance/variable-interpolation.json. The console
// runs the same file (variable-interpolation-conformance.test.ts), and both must give the same text or refuse.
type interpolationConformance struct {
	Interpolate []struct {
		Name     string            `json:"name"`
		Template string            `json:"template"`
		Types    map[string]string `json:"types"`
		Values   map[string]any    `json:"values"`
		Expected *string           `json:"expected"`
		Error    bool              `json:"error"`
	} `json:"interpolate"`
	Resolve []struct {
		Name      string                  `json:"name"`
		Variables []dashboardReadVariable `json:"variables"`
		Overrides json.RawMessage         `json:"overrides"`
		Expected  map[string]any          `json:"expected"`
		Error     bool                    `json:"error"`
	} `json:"resolve"`
}

func loadInterpolationConformance(t *testing.T) interpolationConformance {
	t.Helper()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/variable-interpolation.json")
	require.NoError(t, err)
	var fixtures interpolationConformance
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Interpolate)
	return fixtures
}

func TestVariableInterpolationConformanceFixtures(t *testing.T) {
	for _, entry := range loadInterpolationConformance(t).Interpolate {
		t.Run(entry.Name, func(t *testing.T) {
			got, err := interpolateDashboardLiterals(entry.Template, entry.Types, entry.Values)
			if entry.Error {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.NotNil(t, entry.Expected, "a fixture needs expected or error")
			require.Equal(t, *entry.Expected, got)
		})
	}
}

// Resolution decodes the overrides as the query_dashboard boundary does, then applies the declarations.
func TestVariableResolutionConformanceFixtures(t *testing.T) {
	fixtures := loadInterpolationConformance(t)
	require.NotEmpty(t, fixtures.Resolve)
	for _, entry := range fixtures.Resolve {
		t.Run(entry.Name, func(t *testing.T) {
			resolved, err := func() (map[string]variablevalue.Value, error) {
				var overrides map[string]variablevalue.Value
				if err := json.Unmarshal(entry.Overrides, &overrides); err != nil {
					return nil, err
				}
				return dashboardVariableValues(entry.Variables, overrides)
			}()
			if entry.Error {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			encoded, err := json.Marshal(resolved)
			require.NoError(t, err)
			var got map[string]any
			require.NoError(t, json.Unmarshal(encoded, &got))
			require.Equal(t, entry.Expected, got)
		})
	}
}

// A regex list must match every item it was built from, and nothing that merely contains an item as a prefix.
func TestListAlternationMatchesItemsExactlyAsWritten(t *testing.T) {
	items := []string{"a.b", "c|d", `e"f`, `g\h`, "omega"}
	escaped := make([]string, len(items))
	for index, item := range items {
		escaped[index] = regexp.QuoteMeta(item)
	}
	pattern := regexp.MustCompile("^(?:" + strings.Join(escaped, "|") + ")$")
	for _, item := range items {
		require.True(t, pattern.MatchString(item), item)
	}
	require.False(t, pattern.MatchString("a.bX"))
	require.False(t, pattern.MatchString("aXb"))
}
