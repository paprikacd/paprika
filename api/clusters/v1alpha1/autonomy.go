package v1alpha1

import (
	"slices"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ManagementPolicy aliases the shared policy vocabulary. It lives in the
// pipelines API because Stage and Application declare their own requests; a
// Cluster declares the ceiling, and both sides must mean the same thing by
// "Prune".
type ManagementPolicy = paprikav1.ManagementPolicy

const (
	ManagementPolicyObserve  = paprikav1.ManagementPolicyObserve
	ManagementPolicyApply    = paprikav1.ManagementPolicyApply
	ManagementPolicyPrune    = paprikav1.ManagementPolicyPrune
	ManagementPolicyDelete   = paprikav1.ManagementPolicyDelete
	ManagementPolicySelfHeal = paprikav1.ManagementPolicySelfHeal
	ManagementPolicyRollout  = paprikav1.ManagementPolicyRollout
	ManagementPolicyAll      = paprikav1.ManagementPolicyAll
)

// AutonomyMode selects what a satellite does while it cannot reach the control
// plane. It is the difference between a cluster that goes dark during a WAN
// partition and one that keeps its own reconciliation loop running.
type AutonomyMode string

const (
	// AutonomyObserveOnly makes the satellite a reporter. It never reconciles
	// locally, so a control-plane outage freezes deployments until the link
	// returns. This is the safe default for brownfield clusters: nothing on the
	// cluster is mutated by an agent the operator has not vetted.
	AutonomyObserveOnly AutonomyMode = "ObserveOnly"
	// AutonomyFailover lets the control plane reconcile while connected and
	// hands reconciliation to the satellite once FailoverTimeout elapses with no
	// control-plane contact. Two reconcilers never work at once because the
	// handover is one directional and gated on the timeout.
	AutonomyFailover AutonomyMode = "Failover"
	// AutonomyDelegated always reconciles on the satellite. The control plane
	// supplies desired state and receives status; it never runs the apply loop
	// against this cluster. A link failure therefore changes nothing locally.
	AutonomyDelegated AutonomyMode = "Delegated"
)

// DefaultAutonomyMode is used when spec.satellite.autonomy is unset. Failover
// preserves the historic behaviour of a control-plane-driven apply path while
// still giving the cluster a way to keep reconciling through an outage.
func DefaultAutonomyMode() AutonomyMode { return AutonomyFailover }

// NormalizeAutonomyMode resolves an unset mode to its default.
func NormalizeAutonomyMode(mode AutonomyMode) AutonomyMode {
	if mode == "" {
		return DefaultAutonomyMode()
	}
	return mode
}

// Valid reports whether mode is a mode this build implements.
func (mode AutonomyMode) Valid() bool {
	switch mode {
	case AutonomyObserveOnly, AutonomyFailover, AutonomyDelegated:
		return true
	default:
		return false
	}
}

// ReconcilesLocally reports whether a satellite in this mode runs its own
// controllers at all. ObserveOnly never does; the other two do, either from
// startup (Delegated) or after the failover timeout (Failover).
func (mode AutonomyMode) ReconcilesLocally() bool {
	return NormalizeAutonomyMode(mode) != AutonomyObserveOnly
}

// SatelliteOperatingState is what a satellite is doing right now. It is
// observed, not declared: an operator sets autonomy, the satellite reports which
// branch of that policy it is in.
type SatelliteOperatingState string

const (
	// SatelliteOperatingConnecting means the satellite has not yet completed a
	// session handshake. No claim is made about reconciliation.
	SatelliteOperatingConnecting SatelliteOperatingState = "Connecting"
	// SatelliteOperatingConnected means the control plane is authoritative and
	// the link is current.
	SatelliteOperatingConnected SatelliteOperatingState = "Connected"
	// SatelliteOperatingAutonomous means the satellite is reconciling without
	// the control plane.
	SatelliteOperatingAutonomous SatelliteOperatingState = "Autonomous"
	// SatelliteOperatingOverrideHeld means the satellite took a local action
	// mid-outage that the control plane has not yet acknowledged. The control
	// plane surfaces this instead of silently overwriting it.
	SatelliteOperatingOverrideHeld SatelliteOperatingState = "OverrideHeld"
	// SatelliteOperatingDisabled means the cluster is administratively off.
	SatelliteOperatingDisabled SatelliteOperatingState = "Disabled"
)

// EffectiveManagementPolicies intersects the cluster's ceiling with a
// placement's request. An empty result means the placement is observed but
// never mutated on this cluster.
func EffectiveManagementPolicies(cluster, placement []ManagementPolicy) []ManagementPolicy {
	return paprikav1.IntersectManagementPolicies(cluster, placement)
}

// ClusterAllows reports whether the cluster ceiling permits one policy for a
// placement that requested it.
func ClusterAllows(cluster, placement []ManagementPolicy, action ManagementPolicy) bool {
	return slices.Contains(EffectiveManagementPolicies(cluster, placement), action)
}
