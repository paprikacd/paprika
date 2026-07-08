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

func requireMap(t *testing.T, values map[string]interface{}, key string) map[string]interface{} {
	t.Helper()

	value, ok := values[key].(map[string]interface{})
	require.Truef(t, ok, "expected %q to be a map, got %T", key, values[key])
	return value
}
