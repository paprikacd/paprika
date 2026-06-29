package canary

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
	"github.com/benebsworth/paprika/internal/rollout/testutil"
)

func TestCanaryCreatesStable(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: []rolloutsv1alpha1.CanaryStep{{SetWeight: 20}}})
	ro := makeRollout("r1", EmptyTemplate("v1"))
	status := rolloutsv1alpha1.RolloutStatus{}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionCreateStable {
		t.Fatalf("expected CreateStable, got %s", res.Action)
	}
}

func TestCanaryCreatesCanaryAndSteps(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: []rolloutsv1alpha1.CanaryStep{{SetWeight: 20}, {SetWeight: 50}, {SetWeight: 100}}})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{StableRS: "r1-stable-" + hash.Template(tmpl1)}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionStep {
		t.Fatalf("expected Step, got %s", res.Action)
	}
	if len(res.ReplicaSets) != 2 {
		t.Fatalf("expected 2 ReplicaSets, got %d", len(res.ReplicaSets))
	}
}

func TestCanaryPromotesAfterLastStep(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: []rolloutsv1alpha1.CanaryStep{{SetWeight: 100}}})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "r1-stable-" + hash.Template(tmpl1),
		CanaryRS:         "r1-canary-" + hash.Template(EmptyTemplate("v2")),
		CurrentStepIndex: 1,
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionPromote {
		t.Fatalf("expected Promote, got %s", res.Action)
	}
}

func makeRollout(name string, tmpl *corev1.PodTemplateSpec) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: *tmpl,
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Canary"},
		},
	}
}

func TestCanaryAdvancesAfterDuration(t *testing.T) {
	steps := []rolloutsv1alpha1.CanaryStep{
		{SetWeight: 25, Duration: durationFromSeconds(60)},
		{SetWeight: 50, Duration: durationFromSeconds(60)},
		{SetWeight: 100},
	}
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: steps})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	startedAt := testutil.TimeAt(-2 * time.Minute) // 120s ago, step duration is 60s
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:             "r1-stable-" + hash.Template(tmpl1),
		CanaryRS:             "r1-canary-" + hash.Template(EmptyTemplate("v2")),
		CurrentStepIndex:     0,
		CurrentStepStartedAt: &startedAt,
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if status.CurrentStepIndex != 1 {
		t.Fatalf("expected CurrentStepIndex=1 after duration elapsed, got %d", status.CurrentStepIndex)
	}
	if res.Action != core.ActionStep {
		t.Fatalf("expected Step action for next step, got %s", res.Action)
	}
}

func TestCanaryDoesNotAdvanceBeforeDuration(t *testing.T) {
	steps := []rolloutsv1alpha1.CanaryStep{
		{SetWeight: 25, Duration: durationFromSeconds(60)},
		{SetWeight: 50},
	}
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: steps})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	startedAt := testutil.TimeAt(-10 * time.Second) // only 10s ago
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:             "r1-stable-" + hash.Template(tmpl1),
		CanaryRS:             "r1-canary-" + hash.Template(EmptyTemplate("v2")),
		CurrentStepIndex:     0,
		CurrentStepStartedAt: &startedAt,
	}

	_, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if status.CurrentStepIndex != 0 {
		t.Fatalf("expected CurrentStepIndex=0 (duration not elapsed), got %d", status.CurrentStepIndex)
	}
}

func TestCanaryAdvancesImmediatelyWhenNoDuration(t *testing.T) {
	steps := []rolloutsv1alpha1.CanaryStep{
		{SetWeight: 25}, // no duration => advance immediately on first reconcile
		{SetWeight: 50},
	}
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: steps})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "r1-stable-" + hash.Template(tmpl1),
		CanaryRS:         "r1-canary-" + hash.Template(EmptyTemplate("v2")),
		CurrentStepIndex: 0,
		// CurrentStepStartedAt intentionally nil
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	// Implementation must advance a no-duration step on the SAME reconcile it
	// was entered (it doesn't need to stamp-and-wait).
	if status.CurrentStepIndex != 1 {
		t.Fatalf("expected CurrentStepIndex=1 (advance on no duration), got %d", status.CurrentStepIndex)
	}
	if res.Action != core.ActionStep {
		t.Fatalf("expected Step for next step, got %s", res.Action)
	}
}

func TestCanaryStampsCurrentStepStartedAt(t *testing.T) {
	steps := []rolloutsv1alpha1.CanaryStep{{SetWeight: 25, Duration: durationFromSeconds(60)}}
	s := NewStrategy(&rolloutsv1alpha1.CanaryStrategy{Steps: steps})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "r1-stable-" + hash.Template(tmpl1),
		CanaryRS:         "r1-canary-" + hash.Template(EmptyTemplate("v2")),
		CurrentStepIndex: 0,
	}

	_, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	// We did not advance (duration is 60s, started just now), but
	// CurrentStepStartedAt must now be set so the next reconcile can measure.
	if status.CurrentStepStartedAt == nil {
		t.Fatal("expected CurrentStepStartedAt to be set when entering a step")
	}
}

func durationFromSeconds(s int) *metav1.Duration {
	return &metav1.Duration{Duration: time.Duration(s) * time.Second}
}
