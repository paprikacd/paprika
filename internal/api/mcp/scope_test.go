package mcp

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseScopes(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want []Scope
	}{
		{"empty", "", nil},
		{"single", "paprika:read", []Scope{ScopeRead}},
		{"both", "paprika:read paprika:write", []Scope{ScopeRead, ScopeWrite}},
		{"extra whitespace", "  paprika:read   paprika:write ", []Scope{ScopeRead, ScopeWrite}},
		{"unknown dropped", "paprika:read openid profile", []Scope{ScopeRead}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ParseScopes(tt.raw))
		})
	}
}

func TestHasScopeDoesNotImplyWriteFromRead(t *testing.T) {
	granted := []Scope{ScopeRead}
	assert.True(t, HasScope(granted, ScopeRead))
	assert.False(t, HasScope(granted, ScopeWrite),
		"read must never imply write")
}

func TestHasScopeWriteDoesNotImplyRead(t *testing.T) {
	granted := []Scope{ScopeWrite}
	assert.False(t, HasScope(granted, ScopeRead),
		"scopes are explicit; write does not grant read")
}

func TestHasScopeEmptyGrantsNothing(t *testing.T) {
	assert.False(t, HasScope(nil, ScopeRead))
	assert.False(t, HasScope(nil, ScopeWrite))
}

func TestHasScopeWriteGrantsWrite(t *testing.T) {
	granted := []Scope{ScopeWrite}
	assert.True(t, HasScope(granted, ScopeWrite))
}

func TestHasScopeBothGrantsBoth(t *testing.T) {
	granted := []Scope{ScopeRead, ScopeWrite}
	assert.True(t, HasScope(granted, ScopeRead))
	assert.True(t, HasScope(granted, ScopeWrite))
}
