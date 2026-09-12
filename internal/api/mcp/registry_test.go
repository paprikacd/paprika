package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func validTool() Tool {
	return Tool{
		Name:        "fleet_status",
		Description: "Summarise fleet health.",
		Scope:       ScopeRead,
		InputSchema: json.RawMessage(`{"type":"object"}`),
		Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
			return nil, nil
		},
	}
}

func TestRegisterRejectsMissingScope(t *testing.T) {
	tool := validTool()
	tool.Scope = ""
	err := NewRegistry().Register(tool)
	require.Error(t, err, "scope must be declared explicitly, never inferred")
	assert.Contains(t, err.Error(), "scope")
}

func TestRegisterRejectsDuplicateName(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(validTool()))
	assert.Error(t, r.Register(validTool()))
}

func TestRegisterRejectsMissingInvoke(t *testing.T) {
	tool := validTool()
	tool.Invoke = nil
	assert.Error(t, NewRegistry().Register(tool))
}

func TestRegisterRejectsDestructiveRead(t *testing.T) {
	tool := validTool()
	tool.Destructive = true
	err := NewRegistry().Register(tool)
	require.Error(t, err, "a read tool cannot be destructive")
}

func TestLookupAndAll(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, r.Register(validTool()))

	got, ok := r.Lookup("fleet_status")
	require.True(t, ok)
	assert.Equal(t, ScopeRead, got.Scope)

	_, ok = r.Lookup("nope")
	assert.False(t, ok)
	assert.Len(t, r.All(), 1)
}
