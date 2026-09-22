// Package dataprovider defines the pluggable capacity-source model: the value
// types a capacity reading is expressed in, and the CapacitySource interface
// that concrete implementations (e.g. metrics-server, cloud billing APIs)
// satisfy. It intentionally has no dependency on a live cluster, so
// implementations can be unit-tested in isolation.
package dataprovider

import (
	"context"
	"encoding/json"
	"time"
)

// DataState describes the confidence a Sample was produced with. Its
// underlying values line up with the DATA_STATE_* enum in
// internal/api/paprika/v1 (DataState_DATA_STATE_OK == 1, and so on) so a
// later mapping layer can convert between them without a lookup table — but
// this package does not import that generated code, so implementations stay
// unit-testable without a cluster.
//
// The zero value is intentionally left unnamed (see the reserved iota below):
// a Sample left unset by mistake is not equal to StateOK, so callers cannot
// mistake an unset Sample for a successful read.
type DataState int

const (
	_ DataState = iota // reserved: mirrors DATA_STATE_UNSPECIFIED, deliberately unnamed
	// StateOK means the value was read successfully and is fresh.
	StateOK
	// StateNotConfigured means no source is configured to supply this value.
	StateNotConfigured
	// StateNotAvailable means a source is configured but the value could not
	// be produced (e.g. the metric does not exist yet).
	StateNotAvailable
	// StateStale means the value was read successfully but is older than the
	// caller's freshness requirement.
	StateStale
	// StateError means the source attempted the read and failed.
	StateError
	// StateForbidden means the source lacks permission to read the value.
	StateForbidden
)

// Sample is a single measured (or unmeasured) value.
type Sample struct {
	Value  float64
	State  DataState
	Reason string
}

// Meter groups the three views of one resource dimension (e.g. CPU): what is
// used, what is requested, and what is allocatable.
type Meter struct {
	Used        Sample
	Requested   Sample
	Allocatable Sample
	ObservedAt  time.Time
}

// CapacityReading is the full result of one Read call: every resource
// dimension a capacity source knows how to measure.
type CapacityReading struct {
	CPUMillicores Meter
	MemoryBytes   Meter
}

// Field names one of the three values a Meter carries.
type Field string

const (
	// FieldUsed names Meter.Used.
	FieldUsed Field = "used"
	// FieldRequested names Meter.Requested.
	FieldRequested Field = "requested"
	// FieldAllocatable names Meter.Allocatable.
	FieldAllocatable Field = "allocatable"
)

// Descriptor advertises what a CapacitySource is capable of, so callers can
// decide which fields it may be trusted to report rather than inferring it
// from behavior.
type Descriptor struct {
	Name string
	// Supplies lists the fields this source can measure. A field absent from
	// this list must never be reported as StateOK by the source.
	Supplies []Field
	// NeedsEgress is true when Read makes an outbound network call (e.g. to
	// a cloud billing API), so callers can gate it behind network policy.
	NeedsEgress bool
}

// CanSupply reports whether the source claims to be able to measure field.
func (d Descriptor) CanSupply(field Field) bool {
	for _, f := range d.Supplies {
		if f == field {
			return true
		}
	}
	return false
}

// ReadRequest scopes one Read call to a cluster and namespace, carrying the
// source's own provider-specific configuration as opaque JSON.
type ReadRequest struct {
	ClusterKey string
	Namespace  string
	Config     json.RawMessage
}

// CapacitySource is implemented by each concrete capacity provider (e.g. a
// metrics-server adapter or a cloud billing API client).
type CapacitySource interface {
	// Descriptor advertises this source's name and capabilities.
	Descriptor() Descriptor
	// ValidateConfig checks provider-specific configuration ahead of use,
	// before it is ever passed to Read.
	ValidateConfig(config json.RawMessage) error
	// Read produces a CapacityReading for the given request.
	Read(ctx context.Context, req ReadRequest) (CapacityReading, error)
}
