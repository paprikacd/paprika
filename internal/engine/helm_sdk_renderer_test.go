package engine

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildValuesParsesNestedHelmParameters(t *testing.T) {
	t.Parallel()

	renderer := NewHelmSDKRenderer(t.TempDir())
	//nolint:gosec // test fixture validates Helm secret reference keys, not credentials
	values, err := renderer.buildValues(map[string]string{
		"replicaCount":                        "2",
		"gateway.enabled":                     "true",
		"gateway.hostnames[0]":                "origin-vke.telesis.dev",
		"secretEnv.existingSecret":            "telesis-api-env",
		"env.nonSecret.RATE_LIMIT_BURST_SIZE": "60",
		"env.nonSecret.RATE_LIMIT_ENABLED":    "false",
		"firebaseAdmin.existingSecret":        "telesis-firebase-admin",
		"firebaseAdmin.mountPath":             "/etc/telesis/firebase-admin-key.json",
	}, `
gateway:
  enabled: false
  hostnames:
    - old-origin.telesis.dev
env:
  nonSecret:
    RATE_LIMIT_BURST_SIZE: "30"
`)
	require.NoError(t, err)

	assert.EqualValues(t, 2, values["replicaCount"])

	gateway := requireMap(t, values, "gateway")
	assert.Equal(t, true, gateway["enabled"])
	hostnames, ok := gateway["hostnames"].([]interface{})
	require.True(t, ok)
	require.Len(t, hostnames, 1)
	assert.Equal(t, "origin-vke.telesis.dev", hostnames[0])

	secretEnv := requireMap(t, values, "secretEnv")
	assert.Equal(t, "telesis-api-env", secretEnv["existingSecret"])

	firebaseAdmin := requireMap(t, values, "firebaseAdmin")
	assert.Equal(t, "telesis-firebase-admin", firebaseAdmin["existingSecret"])
	assert.Equal(t, "/etc/telesis/firebase-admin-key.json", firebaseAdmin["mountPath"])

	env := requireMap(t, values, "env")
	nonSecret := requireMap(t, env, "nonSecret")
	assert.EqualValues(t, 60, nonSecret["RATE_LIMIT_BURST_SIZE"])
	assert.Equal(t, false, nonSecret["RATE_LIMIT_ENABLED"])
}

func TestBuildValuesReportsInvalidParameterPaths(t *testing.T) {
	t.Parallel()

	renderer := NewHelmSDKRenderer(t.TempDir())
	_, err := renderer.buildValues(map[string]string{
		"gateway.hostnames[bad]": "origin-vke.telesis.dev",
	}, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "parse parameter")
}

// PromQL exprs routinely contain commas (histogram_quantile(a, b)) and range
// selectors ([10m]). Raw strvals treats "," as list syntax and then parses
// the remainder as a key path, failing on "10m" as an index — this is what
// stalled every cuttlefish Deploy VKE run (render of
// observability.prometheus.extraRuleGroups[0].rules[4].expr).
func TestBuildValuesPreservesCommasAndBackslashesInParameterValues(t *testing.T) {
	t.Parallel()

	expr := `histogram_quantile(0.95, sum by (le) (rate(check_queue_delay_bucket[10m]))) > 30000`
	path := `C:\runner\work`
	renderer := NewHelmSDKRenderer(t.TempDir())
	values, err := renderer.buildValues(map[string]string{
		"observability.prometheus.extraRuleGroups[0].rules[4].expr": expr,
		"runner.workRoot": path,
		"simple.list[0]":  "a",
		"simple.list[1]":  "b,c",
	}, "")
	require.NoError(t, err)

	obs := requireMap(t, values, "observability")
	prom := requireMap(t, obs, "prometheus")
	groups, ok := prom["extraRuleGroups"].([]interface{})
	require.True(t, ok)
	require.Len(t, groups, 1)
	group, ok := groups[0].(map[string]interface{})
	require.True(t, ok)
	rules, ok := group["rules"].([]interface{})
	require.True(t, ok)
	require.Len(t, rules, 5) // sparse: index 4 is the one the cuttlefish Application sets
	rule, ok := rules[4].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, expr, rule["expr"])

	runner := requireMap(t, values, "runner")
	assert.Equal(t, path, runner["workRoot"])

	simple := requireMap(t, values, "simple")
	list, ok := simple["list"].([]interface{})
	require.True(t, ok)
	assert.Equal(t, []interface{}{"a", "b,c"}, list)
}

func requireMap(t *testing.T, values map[string]interface{}, key string) map[string]interface{} {
	t.Helper()

	value, ok := values[key].(map[string]interface{})
	require.Truef(t, ok, "expected %q to be a map, got %T", key, values[key])
	return value
}
