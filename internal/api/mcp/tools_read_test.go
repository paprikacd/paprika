package mcp

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRegisterReadToolsRegistersAllFourteen(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))

	want := []string{
		"fleet_status", "list_clusters", "fleet_map", "list_applications",
		"get_application", "investigate", "get_resource_tree", "get_logs",
		"list_pipelines", "get_pipeline_run", "list_releases", "list_rollouts",
		"get_rollout", "query_cost",
	}
	assert.Len(t, r.All(), len(want))
	for _, name := range want {
		tool, ok := r.Lookup(name)
		require.True(t, ok, "missing tool %q", name)
		assert.Equal(t, ScopeRead, tool.Scope, "%q must be read-scoped", name)
		assert.False(t, tool.Destructive)
	}
}

func TestReadToolSchemasAreValidJSON(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, tool := range r.All() {
		var schema map[string]any
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema), tool.Name)
		assert.Equal(t, "object", schema["type"], tool.Name)
		assert.NotEmpty(t, tool.Description, "%q needs a description", tool.Name)
	}
}

func TestListToolsDefaultPageSizeIsCapped(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	for _, name := range []string{"list_applications", "list_clusters", "list_releases"} {
		tool, ok := r.Lookup(name)
		require.True(t, ok)
		var schema struct {
			Properties struct {
				PageSize struct {
					Default int `json:"default"`
					Maximum int `json:"maximum"`
				} `json:"page_size"` //nolint:tagliatelle // matches the tool's wire schema, which is snake_case
			} `json:"properties"`
		}
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
		assert.Equal(t, 50, schema.Properties.PageSize.Default, name)
		assert.LessOrEqual(t, schema.Properties.PageSize.Maximum, 200, name)
	}
}
