package bluegreen

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

func TestBlueGreenCreatesActive(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{ActiveService: "active"})
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

func TestBlueGreenCreatesPreview(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{ActiveService: "active"})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{StableRS: "r1-active-" + hash.Template(tmpl1)}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionPause {
		t.Fatalf("expected Pause, got %s", res.Action)
	}
}

func TestBlueGreenPromotesOnAnnotation(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{ActiveService: "active"})
	tmpl := EmptyTemplate("v2")
	ro := makeRollout("r1", tmpl)
	ro.Annotations = map[string]string{core.PromoteAnnotation: "true"}
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: "r1-active-old",
		CanaryRS: "r1-preview-" + hash.Template(tmpl),
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionPromote {
		t.Fatalf("expected Promote, got %s", res.Action)
	}
}

func TestBlueGreenAbortsOnAnnotation(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{ActiveService: "active"})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	ro.Annotations = map[string]string{core.AbortAnnotation: ""}
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: "r1-active-" + hash.Template(tmpl1),
		CanaryRS: "r1-preview-" + hash.Template(EmptyTemplate("v2")),
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionAbort {
		t.Fatalf("expected ActionAbort, got %s", res.Action)
	}
	if res.Phase != rolloutsv1alpha1.RolloutPhaseAborted {
		t.Fatalf("expected Phase=Aborted, got %s", res.Phase)
	}
	foundStable, foundScaledDown := false, false
	for _, rs := range res.ReplicaSets {
		if rs.Labels["rollouts.paprika.io/stable"] == "true" {
			foundStable = true
		}
		if rs.Labels["rollouts.paprika.io/canary"] == "true" && rs.Replicas == 0 {
			foundScaledDown = true
		}
	}
	if !foundStable {
		t.Error("abort result did not include stable RS")
	}
	if !foundScaledDown {
		t.Error("abort result did not scale preview RS to 0")
	}
}

func TestBlueGreenAutoPromotesAfterTimeout(t *testing.T) {
	autoSec := int32(60)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:        "bg-active",
		AutoPromotionSeconds: &autoSec,
	})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("bg", EmptyTemplate("v2"))
	previewHealthy := testutil.TimeAt(-61 * time.Second) // 61s ago
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:            "bg-active-" + hash.Template(tmpl1),
		CanaryRS:            "bg-preview-" + hash.Template(EmptyTemplate("v2")),
		CanaryReadyReplicas: 1,
		PreviewHealthyAt:    &previewHealthy,
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(1, 1))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionPromote {
		t.Fatalf("expected Promote after autoPromotionSeconds, got %s", res.Action)
	}
	if status.PromotedAt == nil {
		t.Error("expected PromotedAt to be stamped after auto-promote")
	}
	if status.PreviousActiveRS == "" {
		t.Error("expected PreviousActiveRS to be set to the prior active after auto-promote")
	}
	if status.CanaryRS != "" {
		t.Error("expected CanaryRS to be cleared after promote (preview is being promoted)")
	}
}

func TestBlueGreenDoesNotAutoPromoteBeforeTimeout(t *testing.T) {
	autoSec := int32(60)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:        "bg-active",
		AutoPromotionSeconds: &autoSec,
	})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("bg", EmptyTemplate("v2"))
	previewHealthy := testutil.TimeAt(-10 * time.Second)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:            "bg-active-" + hash.Template(tmpl1),
		CanaryRS:            "bg-preview-" + hash.Template(EmptyTemplate("v2")),
		CanaryReadyReplicas: 1,
		PreviewHealthyAt:    &previewHealthy,
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(1, 1))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action == core.ActionPromote {
		t.Fatal("should not auto-promote before timeout")
	}
}

func TestBlueGreenScalesDownAfterDelay(t *testing.T) {
	delaySec := int32(30)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:         "bg-active",
		ScaleDownDelaySeconds: &delaySec,
	})
	tmpl1 := EmptyTemplate("v1")
	tmpl2 := EmptyTemplate("v2")
	ro := makeRollout("bg", tmpl2)
	promotedAt := testutil.TimeAt(-31 * time.Second) // 31s ago, delay is 30s
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "bg-active-" + hash.Template(tmpl2), // new active (already promoted)
		PreviousActiveRS: "bg-active-" + hash.Template(tmpl1), // prior active, awaiting drain
		PromotedAt:       &promotedAt,
	}

	// The previous active RS is still fully ready (the controller hasn't scaled
	// it yet). Use InputsReady to express this — the controller observes the
	// PreviousActiveRS onto CanaryReadyReplicas during drain.
	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(1, 1))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	found := false
	for _, rs := range res.ReplicaSets {
		if rs.Name == status.PreviousActiveRS && rs.Replicas == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected previous active RS scaled to 0 after scaleDownDelaySeconds; got %+v", res.ReplicaSets)
	}
}

func TestBlueGreenKeepsOldRSBeforeDelay(t *testing.T) {
	delaySec := int32(30)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:         "bg-active",
		ScaleDownDelaySeconds: &delaySec,
	})
	tmpl1 := EmptyTemplate("v1")
	tmpl2 := EmptyTemplate("v2")
	ro := makeRollout("bg", tmpl2)
	promotedAt := testutil.TimeAt(-10 * time.Second) // only 10s ago
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "bg-active-" + hash.Template(tmpl2),
		PreviousActiveRS: "bg-active-" + hash.Template(tmpl1),
		PromotedAt:       &promotedAt,
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(1, 1))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	for _, rs := range res.ReplicaSets {
		if rs.Name == status.PreviousActiveRS && rs.Replicas == 0 {
			t.Fatal("previous active RS should not be scaled to 0 before scaleDownDelaySeconds")
		}
	}
}

func TestBlueGreenExitsDrainWhenPreviousActiveIsZero(t *testing.T) {
	delaySec := int32(30)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:         "bg-active",
		ScaleDownDelaySeconds: &delaySec,
	})
	tmpl2 := EmptyTemplate("v2")
	ro := makeRollout("bg", tmpl2)
	promotedAt := testutil.TimeAt(-61 * time.Second)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "bg-active-" + hash.Template(tmpl2),
		PreviousActiveRS: "bg-active-old", // still set, but observed at 0 ready (see below)
		PromotedAt:       &promotedAt,
	}
	// InputsReady(1, 0): new active has 1 ready, previous active has 0 ready (already drained).
	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(1, 0))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionComplete {
		t.Fatalf("expected Complete after drain finished, got %s", res.Action)
	}
	if status.PreviousActiveRS != "" {
		t.Errorf("expected PreviousActiveRS cleared, got %q", status.PreviousActiveRS)
	}
	if status.PromotedAt != nil {
		t.Errorf("expected PromotedAt cleared, got %v", status.PromotedAt)
	}
}

func TestBlueGreenAutoPromoteResetsAcrossRollouts(t *testing.T) {
	autoSec := int32(60)
	s := NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService:        "bg-active",
		AutoPromotionSeconds: &autoSec,
	})
	tmpl2 := EmptyTemplate("v2")
	tmpl3 := EmptyTemplate("v3")

	// Simulate the tail of a completed v1->v2 rollout: PromotedAt cleared
	// (drain finished), StableRS names the v2 active, PreviewHealthyAt
	// still holding a stale value from the v2 cycle.
	staleHealthy := testutil.TimeAt(-2 * time.Hour)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:         "bg-active-" + hash.Template(tmpl2),
		PreviewHealthyAt: &staleHealthy, // stale from prior cycle - MUST be reset
	}

	// Bump template to v3 to start a new rollout.
	ro := makeRollout("bg", tmpl3)

	// First reconcile: should create the v3 preview AND reset PreviewHealthyAt.
	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionPause {
		t.Fatalf("expected Pause (preview created, waiting for healthy), got %s", res.Action)
	}
	if status.PreviewHealthyAt != nil {
		t.Fatalf("PreviewHealthyAt must be reset when creating a new preview; got %v", status.PreviewHealthyAt)
	}
	// The strategy returns the desired RSes; the controller stamps
	// status.CanaryRS afterwards from this list.
	expectedPreview := "bg-preview-" + hash.Template(tmpl3)
	foundPreview := false
	for _, rs := range res.ReplicaSets {
		if rs.Name == expectedPreview {
			foundPreview = true
		}
	}
	if !foundPreview {
		t.Fatalf("expected preview RS %q in result; got %+v", expectedPreview, res.ReplicaSets)
	}
}

func makeRollout(name string, tmpl *corev1.PodTemplateSpec) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: *tmpl,
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "BlueGreen"},
		},
	}
}
