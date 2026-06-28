// Package core defines the shared types for rollout strategies.
package core

import (
	"context"
	"time"

	corev1 "k8s.io/api/core/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
)

// Shared annotation constants. Strategies must read these rather than
// redeclaring them locally.
const (
	AbortAnnotation   = "paprika.io/abort"
	PromoteAnnotation = "paprika.io/promote"
)

// Strategy computes the desired next state of a Rollout.
type Strategy interface {
	Type() string
	Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, in SyncInputs) (*SyncResult, error)
	Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error
}

// SyncInputs carries controller-observed state into a strategy Sync call.
// Strategies must not reach back into the cluster; everything they need to
// make a decision is on the Rollout, the status, or this struct.
type SyncInputs struct {
	Clock clock.Clock

	// StableReadyReplicas is the observed .status.readyReplicas of the RS
	// named in status.StableRS. Zero if the RS does not yet exist.
	StableReadyReplicas int32

	// CanaryReadyReplicas is the observed .status.readyReplicas of the RS
	// named in status.CanaryRS (or the preview RS for BlueGreen). Zero if absent.
	CanaryReadyReplicas int32
}

// NewSyncInputs builds a SyncInputs with a real clock and zero readiness.
// Pass a non-nil clock from tests for determinism.
func NewSyncInputs(clk clock.Clock) SyncInputs {
	if clk == nil {
		clk = clock.Real{}
	}
	return SyncInputs{Clock: clk}
}

// WithReadyReplicas returns a copy of in with the given readiness counts.
// Builder-style helper for tests and the controller.
func (in SyncInputs) WithReadyReplicas(stable, canary int32) SyncInputs {
	in.StableReadyReplicas = stable
	in.CanaryReadyReplicas = canary
	return in
}

// Now returns the current time from the injected clock.
func (in SyncInputs) Now() time.Time {
	if in.Clock == nil {
		return time.Now()
	}
	return in.Clock.Now()
}

// SyncResult is the output of a strategy Sync call.
type SyncResult struct {
	Phase       rolloutsv1alpha1.RolloutPhase
	Action      Action
	Message     string
	ReplicaSets []ReplicaSetAction
}

// Action describes the high-level action the controller should take.
type Action string

const (
	ActionNone         Action = ""
	ActionCreateStable Action = "CreateStable"
	ActionPromote      Action = "Promote"
	ActionStep         Action = "Step"
	ActionPause        Action = "Pause"
	ActionRollback     Action = "Rollback"
	ActionComplete     Action = "Complete"
	ActionAbort        Action = "Abort"
)

// ReplicaSetAction describes a ReplicaSet the controller should reconcile.
type ReplicaSetAction struct {
	Name     string
	Replicas int32
	Template *corev1.PodTemplateSpec
	Labels   map[string]string
}
