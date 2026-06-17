package abtest

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
)

func TestABTestValidationRequiresRoute(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.ABTestStrategy{Routes: []rolloutsv1alpha1.ABTestRoute{}})
	ro := makeRollout("r1", EmptyTemplate("v1"))
	if _, err := s.Sync(context.Background(), ro, &rolloutsv1alpha1.RolloutStatus{}); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestABTestCreatesCanary(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.ABTestStrategy{
		Routes: []rolloutsv1alpha1.ABTestRoute{{Type: "Header", Name: "X-Canary", Value: "true", Service: "canary"}},
	})
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

func TestABTestPromotesOnAnnotation(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.ABTestStrategy{
		Routes: []rolloutsv1alpha1.ABTestRoute{{Type: "Header", Name: "X-Canary", Value: "true", Service: "canary"}},
	})
	tmpl := EmptyTemplate("v2")
	ro := makeRollout("r1", tmpl)
	ro.Annotations = map[string]string{promoteAnnotation: "true"}
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: "r1-stable-old",
		CanaryRS: "r1-canary-" + hash.Template(tmpl),
	}

	res, err := s.Sync(context.Background(), ro, &status)
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionPromote {
		t.Fatalf("expected Promote, got %s", res.Action)
	}
}

func makeRollout(name string, tmpl corev1.PodTemplateSpec) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: tmpl,
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "ABTest"},
		},
	}
}
