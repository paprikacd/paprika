package rolling

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
	"github.com/benebsworth/paprika/internal/rollout/testutil"
)

func TestRollingStrategyCreatesStable(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	ro := makeRollout("r1", EmptyTemplate("v1"))
	status := rolloutsv1alpha1.RolloutStatus{}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionCreateStable {
		t.Fatalf("expected CreateStable, got %s", res.Action)
	}
	if len(res.ReplicaSets) != 1 {
		t.Fatalf("expected 1 ReplicaSet, got %d", len(res.ReplicaSets))
	}
}

func TestRollingStrategyCompletesWhenStableMatches(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	tmpl := EmptyTemplate("v1")
	ro := makeRollout("r1", tmpl)
	status := rolloutsv1alpha1.RolloutStatus{StableRS: "r1-" + hash.Template(tmpl)}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionComplete {
		t.Fatalf("expected Complete, got %s", res.Action)
	}
}

func TestRollingStrategyReplacesOnTemplateChange(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	status := rolloutsv1alpha1.RolloutStatus{StableRS: "r1-" + hash.Template(tmpl1)}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync failed: %v", err)
	}
	if res.Action != core.ActionCreateStable {
		t.Fatalf("expected CreateStable, got %s", res.Action)
	}
	if len(res.ReplicaSets) != 2 {
		t.Fatalf("expected 2 ReplicaSets, got %d", len(res.ReplicaSets))
	}
}

func TestRollingAbortsOnAnnotation(t *testing.T) {
	s := NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	tmpl1 := EmptyTemplate("v1")
	ro := makeRollout("r1", EmptyTemplate("v2"))
	ro.Annotations = map[string]string{core.AbortAnnotation: ""}
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: "r1-" + hash.Template(tmpl1),
		// Rolling has no canary RS during normal operation.
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
	if len(res.ReplicaSets) != 1 {
		t.Fatalf("expected exactly 1 RS action (stable only), got %d", len(res.ReplicaSets))
	}
	if res.ReplicaSets[0].Labels["rollouts.paprika.io/stable"] != "true" {
		t.Error("abort result did not include stable RS")
	}
}

func makeRollout(name string, tmpl *corev1.PodTemplateSpec) *rolloutsv1alpha1.Rollout {
	return &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: *tmpl,
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Rolling"},
		},
	}
}
