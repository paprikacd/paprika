package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// InvokeFunc executes a tool by calling the Connect API. Implementations hold
// no authorization logic: the interceptor chain behind client enforces it.
type InvokeFunc func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error)

// Tool is one MCP tool. Scope is a required field and is never derived from
// the procedure name — see the spec's Context section for why that derivation
// is unsafe.
type Tool struct {
	Name        string
	Description string
	Scope       Scope
	Destructive bool
	InputSchema json.RawMessage
	Invoke      InvokeFunc
}

// Registry holds the tools exposed over MCP.
type Registry struct {
	tools map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]Tool)}
}

func (r *Registry) Register(t Tool) error { //nolint:gocritic
	switch {
	case t.Name == "":
		return errors.New("tool name is required")
	case t.Scope != ScopeRead && t.Scope != ScopeWrite:
		return fmt.Errorf("tool %q: scope must be %q or %q", t.Name, ScopeRead, ScopeWrite)
	case t.Invoke == nil:
		return fmt.Errorf("tool %q: Invoke is required", t.Name)
	case t.Destructive && t.Scope != ScopeWrite:
		return fmt.Errorf("tool %q: destructive tools must have scope %q", t.Name, ScopeWrite)
	case len(t.InputSchema) == 0:
		return fmt.Errorf("tool %q: InputSchema is required", t.Name)
	}
	if _, exists := r.tools[t.Name]; exists {
		return fmt.Errorf("tool %q already registered", t.Name)
	}
	r.tools[t.Name] = t
	return nil
}

func (r *Registry) Lookup(name string) (Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// All returns tools sorted by name so listings are stable across calls.
func (r *Registry) All() []Tool {
	out := make([]Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
