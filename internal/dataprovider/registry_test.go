package dataprovider

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// stubSource is a minimal CapacitySource used only to exercise the Registry.
type stubSource struct {
	name string
}

func (s stubSource) Descriptor() Descriptor {
	return Descriptor{Name: s.name}
}

func (s stubSource) ValidateConfig(_ json.RawMessage) error {
	return nil
}

func (s stubSource) Read(_ context.Context, _ ReadRequest) (CapacityReading, error) {
	return CapacityReading{}, nil
}

func TestRegistryRejectsDuplicateNames(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	require.NoError(t, r.RegisterCapacity(stubSource{name: "A"}))
	// Two implementations answering to one name is a startup bug, not a
	// runtime condition to resolve by picking one.
	require.Error(t, r.RegisterCapacity(stubSource{name: "A"}))
}

func TestUnknownProviderIsNotFound(t *testing.T) {
	t.Parallel()
	_, ok := NewRegistry().Capacity("NoSuchThing")
	require.False(t, ok)
}

func TestSuppliesGovernsWhichFieldsMayReportOK(t *testing.T) {
	t.Parallel()
	d := Descriptor{Name: "used-only", Supplies: []Field{FieldUsed}}
	require.True(t, d.CanSupply(FieldUsed))
	// An implementation that cannot measure allocatable must never cause it to
	// be reported as OK.
	require.False(t, d.CanSupply(FieldAllocatable))
}

func TestRegistryCapacityNamesIsSortedAndComplete(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	require.NoError(t, r.RegisterCapacity(stubSource{name: "beta"}))
	require.NoError(t, r.RegisterCapacity(stubSource{name: "alpha"}))

	require.Equal(t, []string{"alpha", "beta"}, r.CapacityNames())

	source, ok := r.Capacity("alpha")
	require.True(t, ok)
	require.Equal(t, "alpha", source.Descriptor().Name)
}
