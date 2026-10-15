package connector

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// stubConnector is a minimal Connector used only to exercise the Registry.
type stubConnector struct {
	name string
}

func (s stubConnector) Descriptor() Descriptor {
	return Descriptor{Name: s.name}
}

func (s stubConnector) ValidateConfig(_ json.RawMessage) error {
	return nil
}

func (s stubConnector) Query(_ context.Context, _ QueryRequest) (*QueryResult, error) {
	return nil, nil
}

func TestRegistryRejectsDuplicateNames(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	require.NoError(t, r.Register(stubConnector{name: "A"}))
	// Two implementations answering to one name is a startup bug, not a
	// runtime condition to resolve by picking one.
	require.ErrorContains(t, r.Register(stubConnector{name: "A"}), "already registered")
}

func TestUnknownConnectorIsNotFound(t *testing.T) {
	t.Parallel()
	_, ok := NewRegistry().Get("NoSuchThing")
	require.False(t, ok)
}

func TestRegistryNamesIsSortedAndComplete(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	require.NoError(t, r.Register(stubConnector{name: "beta"}))
	require.NoError(t, r.Register(stubConnector{name: "alpha"}))

	require.Equal(t, []string{"alpha", "beta"}, r.Names())

	conn, ok := r.Get("alpha")
	require.True(t, ok)
	require.Equal(t, "alpha", conn.Descriptor().Name)
}
