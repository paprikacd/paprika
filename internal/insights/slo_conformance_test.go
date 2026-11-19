package insights

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// sloConformance mirrors docs/design/insights/conformance/slo.json. The UI test reads the same file.
type sloConformance struct {
	Cases []struct {
		Name   string          `json:"name"`
		Kind   string          `json:"kind"`
		Config json.RawMessage `json:"config"`
		Start  float64         `json:"start"`
		End    float64         `json:"end"`
		Result json.RawMessage `json:"result"`
		Expect json.RawMessage `json:"expected"`
	} `json:"cases"`
}

func loadSLOConformance(t *testing.T) sloConformance {
	t.Helper()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/slo.json")
	require.NoError(t, err)
	var fixture sloConformance
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)
	return fixture
}

// sloPartialMatch reports the first place where actual differs from expected. Fields absent from expected
// are not checked, arrays must have the same length, numbers match within 1e-9 relative, and nil matches null.
func sloPartialMatch(actual, expected any, path string) error {
	switch want := expected.(type) {
	case nil:
		if actual != nil {
			return fmt.Errorf("%s: %v != null", path, actual)
		}
	case float64:
		got, ok := actual.(float64)
		if !ok || math.Abs(got-want) > 1e-9*math.Max(1, math.Abs(want)) {
			return fmt.Errorf("%s: %v != %v", path, actual, want)
		}
	case string, bool:
		if actual != want {
			return fmt.Errorf("%s: %v != %v", path, actual, want)
		}
	case []any:
		got, ok := actual.([]any)
		if !ok || len(got) != len(want) {
			return fmt.Errorf("%s: length %v vs %d", path, actual, len(want))
		}
		for i := range want {
			if err := sloPartialMatch(got[i], want[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: %v is not an object", path, actual)
		}
		for key := range want {
			if err := sloPartialMatch(got[key], want[key], path+"."+key); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("%s: unsupported expected type %T", path, expected)
	}
	return nil
}

func decodeAny(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var value any
	require.NoError(t, json.Unmarshal(raw, &value))
	return value
}

func TestSLOConformanceMatchesSharedFixtures(t *testing.T) {
	seen := map[string]bool{}
	for _, testCase := range loadSLOConformance(t).Cases {
		require.False(t, seen[testCase.Name], "duplicate case name %q", testCase.Name)
		seen[testCase.Name] = true
		t.Run(testCase.Name, func(t *testing.T) {
			expected, ok := decodeAny(t, testCase.Expect).(map[string]any)
			require.True(t, ok, "expected must be an object")

			switch testCase.Kind {
			case "compile":
				var actualError any
				cfg, err := validateSLOSummaryConfig(testCase.Config)
				if err != nil {
					actualError = err.Error()
				}
				if actualError == nil {
					query, compileErr := compileSLOQuery(&cfg)
					if compileErr != nil {
						actualError = compileErr.Error()
					} else if want, ok := expected["query"]; ok {
						require.NoError(t, sloPartialMatch(query, want, "query"))
					}
				}
				if want, ok := expected["error"]; ok {
					require.NoError(t, sloPartialMatch(actualError, want, "error"))
				}
			case "step":
				require.NoError(t, sloPartialMatch(sloStepSeconds(testCase.Start, testCase.End), expected["step"], "step"))
			case "evaluate":
				cfg, err := validateSLOSummaryConfig(testCase.Config)
				require.NoError(t, err, "evaluate cases use valid configs")
				var result QueryResult
				require.NoError(t, json.Unmarshal(testCase.Result, &result))
				raw, err := json.Marshal(evaluateSLO(&cfg, &result))
				require.NoError(t, err)
				require.NoError(t, sloPartialMatch(decodeAny(t, raw), expected, "$"))
			default:
				t.Fatalf("unknown kind %q", testCase.Kind)
			}
		})
	}
}
