package mcp

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRegisterWriteToolsMatchesSpecTable(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))

	wantDestructive := map[string]bool{
		"rollback_release": true, "promote_rollout": true, "abort_rollout": true,
		"cancel_pipeline": true, "skip_step": true,
		"sync_application": false, "approve_gate": false, "reject_gate": false,
		"hold_rollout": false, "resume_rollout": false, "retry_step": false,
	}
	assert.Len(t, r.All(), len(wantDestructive))
	for name, destructive := range wantDestructive {
		tool, ok := r.Lookup(name)
		require.True(t, ok, "missing %q", name)
		assert.Equal(t, ScopeWrite, tool.Scope, "%q must be write-scoped", name)
		assert.Equal(t, destructive, tool.Destructive, "%q destructiveness", name)
	}
}

func TestDestructiveToolSchemasAcceptConfirmationToken(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	for _, tool := range r.All() {
		if !tool.Destructive {
			continue
		}
		var schema struct {
			Properties map[string]any `json:"properties"`
		}
		require.NoError(t, json.Unmarshal(tool.InputSchema, &schema))
		assert.Contains(t, schema.Properties, "confirmation_token", tool.Name)
	}
}
