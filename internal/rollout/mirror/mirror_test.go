package mirror

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
)

func TestMirrorValidation(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.MirrorStrategy{MirrorPercent: 0})
	ro := makeRollout("r1", EmptyTemplate("v1"))
	if _, err := s.Sync(context.Background(), ro, &rolloutsv1alpha1.RolloutStatus{}); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestMirrorCreatesCanary(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.MirrorStrategy{MirrorPercent: 10})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{StableRS: "r1-stable-" + hash.Template(tmpl1)}

	res, err := s.Sync(context.Background(), ro, &status)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionStep {
		t.Fatalf("expected Step, got %s", res.Action)
	}
}

func TestMirrorPausesWhileMirroring(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.MirrorStrategy{MirrorPercent: 25})
	tmpl := EmptyTemplate("v2")
	ro := makeRollout("r1", tmpl)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: "r1-stable-old",
		CanaryRS: "r1-canary-" + hash.Template(tmpl),
	}

	res, err := s.Sync(context.Background(), ro, &status)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionPause {
		t.Fatalf("expected Pause, got %s", res.Action)
	}
}

func makeRollout(name string, tmpl *corev1.PodTemplateSpec) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: *tmpl,
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Mirror"},
		},
	}
}
