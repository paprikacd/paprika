package core

import (
	"context"
	"testing"
	"time"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
)

func TestAbortAnnotationConstant(t *testing.T) {
	if AbortAnnotation != "paprika.io/abort" {
		t.Fatalf("AbortAnnotation = %q, want %q", AbortAnnotation, "paprika.io/abort")
	}
	if PromoteAnnotation != "paprika.io/promote" {
		t.Fatalf("PromoteAnnotation = %q, want %q", PromoteAnnotation, "paprika.io/promote")
	}
}

func TestSyncInputsDefaults(t *testing.T) {
	in := NewSyncInputs(nil)
	if in.Clock == nil {
		t.Fatal("expected non-nil default Clock")
	}
	if in.Now().IsZero() {
		t.Fatal("default clock should return non-zero time")
	}
}

func TestNewSyncInputsWithReadyReplicas(t *testing.T) {
	fake := clock.NewFake(time.Now())
	in := NewSyncInputs(fake).WithReadyReplicas(3, 1)
	if in.StableReadyReplicas != 3 || in.CanaryReadyReplicas != 1 {
		t.Fatalf("ready replicas not propagated: stable=%d canary=%d", in.StableReadyReplicas, in.CanaryReadyReplicas)
	}
}

// compile-time check: a custom strategy can read SyncInputs.
type noopStrategy struct{}

func (noopStrategy) Type() string { return "Noop" }
func (noopStrategy) Sync(_ context.Context, _ *rolloutsv1alpha1.Rollout, _ *rolloutsv1alpha1.RolloutStatus, _ SyncInputs) (*SyncResult, error) {
	return &SyncResult{Action: ActionNone}, nil
}
func (noopStrategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error { return nil }

var _ Strategy = noopStrategy{}
