// Package core defines the shared types for rollout strategies.
package core

import (
	"context"

	corev1 "k8s.io/api/core/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

// Strategy computes the desired next state of a Rollout.
type Strategy interface {
	Type() string
	Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*SyncResult, error)
	Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error
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
	// ActionNone means no action is required.
	ActionNone Action = ""
	// ActionCreateStable creates or recreates the stable ReplicaSet.
	ActionCreateStable Action = "CreateStable"
	// ActionPromote promotes the canary/preview to stable.
	ActionPromote Action = "Promote"
	// ActionStep advances to the next canary step.
	ActionStep Action = "Step"
	// ActionPause waits for a manual or time-based promotion signal.
	ActionPause Action = "Pause"
	// ActionRollback rolls back to the previous stable revision.
	ActionRollback Action = "Rollback"
	// ActionComplete marks the rollout as healthy/complete.
	ActionComplete Action = "Complete"
)

// ReplicaSetAction describes a ReplicaSet the controller should reconcile.
type ReplicaSetAction struct {
	Name     string
	Replicas int32
	Template corev1.PodTemplateSpec
	Labels   map[string]string
}
