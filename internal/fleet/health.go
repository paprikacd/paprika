package fleet

const initialUnavailableReason = "fleet snapshot has not been installed"

// ErrUnavailable is returned when the fleet index cannot satisfy an
// availability or readiness check. Reason must contain only safe operational
// context, never credentials or raw requests.
type ErrUnavailable struct {
	Reason string
}

func (e *ErrUnavailable) Error() string {
	if e == nil || e.Reason == "" {
		return "fleet index is unavailable"
	}
	return "fleet index is unavailable: " + e.Reason
}

// HealthState is independent of the serving snapshot. Degraded health never
// discards a previously installed snapshot.
type HealthState struct {
	Ready    bool
	Degraded bool
	Reason   string
}

// SetHealth atomically replaces readiness health without changing the serving
// snapshot. Reasons supplied here must already be safe for operator exposure.
func (i *Index) SetHealth(state HealthState) {
	i.health.Store(&state)
}

// CheckReady reads health only. Snapshot serving availability is checked by
// LoadSnapshot instead.
func (i *Index) CheckReady() error {
	state := i.health.Load()
	if state != nil && state.Ready && !state.Degraded {
		return nil
	}

	reason := "fleet index is not ready"
	if state != nil && state.Reason != "" {
		reason = state.Reason
	} else if state != nil && state.Degraded {
		reason = "fleet index is degraded"
	}
	return &ErrUnavailable{Reason: reason}
}
