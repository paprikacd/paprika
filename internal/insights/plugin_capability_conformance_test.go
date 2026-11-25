package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// pluginCapabilityConformance mirrors docs/design/insights/conformance/plugin-capabilities.json, which
// ui/src/features/insights/plugin-capability-conformance.test.ts writes from Zod and the UI capability table.
type pluginCapabilityConformance struct {
	Cases []struct {
		Name            string          `json:"name"`
		Feature         string          `json:"feature"`
		Dashboard       json.RawMessage `json:"dashboard"`
		Valid           bool            `json:"valid"`
		SelectionActive *bool           `json:"selectionActive"`
	} `json:"cases"`
}

// The Go validator and lint must reach the UI's verdict for every widget family's annotations, tooltip view and
// selection: the same document is accepted or rejected on both sides, and selection bindings are linted as inactive
// exactly where the canvas ignores them.
func TestPluginCapabilitiesMatchTheUI(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/plugin-capabilities.json")
	require.NoError(t, err)
	var fixtures pluginCapabilityConformance
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)

	families := map[string]bool{}
	for _, entry := range fixtures.Cases {
		families[entry.Name] = true
		t.Run(entry.Name+"/"+entry.Feature, func(t *testing.T) {
			err := validateDashboard("capabilities", Dashboard(entry.Dashboard))
			require.Equal(t, entry.Valid, err == nil, "validateDashboard: %v", err)
			if entry.Feature != "selection" {
				return
			}
			require.NotNil(t, entry.SelectionActive, "selection cases record whether the bindings are active")
			inactive := false
			for _, finding := range lintFor(t, Dashboard(entry.Dashboard)) {
				if finding.GetRuleId() == "selection.inactive-binding" {
					inactive = true
				}
			}
			require.Equal(t, !*entry.SelectionActive, inactive, "selection.inactive-binding")
		})
	}
	// Every built-in plugin has a case, so a new plugin cannot skip the comparison.
	for id := range builtInWidgetPlugins {
		require.True(t, families[id], "no capability conformance case for built-in plugin %s", id)
	}
}
