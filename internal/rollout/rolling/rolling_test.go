package rolling

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

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

func makeRolloutWithReplicas(name string, tmpl *corev1.PodTemplateSpec, replicas int32) *rolloutsv1alpha1.Rollout {
	ro := makeRollout(name, tmpl)
	ro.Spec.Replicas = &replicas
	return ro
}

func findRS(actions []core.ReplicaSetAction, label, hash string) *core.ReplicaSetAction {
	for i := range actions {
		if actions[i].Labels["rollouts.paprika.io/"+label] == "true" && actions[i].Labels["rollouts.paprika.io/revision"] == hash {
			return &actions[i]
		}
	}
	return nil
}

func TestRollingSurgesNewBeforeScalingDown(t *testing.T) {
	// surge=1, unavail=0, desired=3, oldReady=3, newReady=0.
	// Phase 1 (scale-down): available=3, floor=3, no headroom -> oldTarget=3.
	// Phase 2 (scale-up):   newTarget = desired+surge-oldTarget = 3+1-3 = 1.
	// So: old=3 (unchanged), new=1 (just created).
	s, ro, status, oldHash, newHash := setupRollingSync(t, 1, 0)

	res, err := s.Sync(context.Background(), ro, status, testutil.InputsReady(3, 0))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	newRS := findRS(res.ReplicaSets, "canary", newHash)
	oldRS := findRS(res.ReplicaSets, "stable", oldHash)
	if newRS == nil || newRS.Replicas != 1 {
		t.Fatalf("expected new (canary) RS replicas=1, got %+v", newRS)
	}
	if oldRS == nil || oldRS.Replicas != 3 {
		t.Fatalf("expected old (stable) RS replicas=3 (no scale-down without headroom), got %+v", oldRS)
	}
}

func TestRollingScalesDownOldAsNewReadinessAllows(t *testing.T) {
	// surge=1, unavail=0, desired=3, oldReady=3, newReady=1 (one new pod ready).
	// Phase 1: available=4, floor=3, scaleDownBy=1 -> oldTarget=2.
	// Phase 2: newTarget = 3+1-2 = 2.
	s, ro, status, oldHash, newHash := setupRollingSync(t, 1, 0)

	res, err := s.Sync(context.Background(), ro, status, testutil.InputsReady(3, 1))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	newRS := findRS(res.ReplicaSets, "canary", newHash)
	oldRS := findRS(res.ReplicaSets, "stable", oldHash)
	if newRS == nil || newRS.Replicas != 2 {
		t.Fatalf("expected new RS replicas=2, got %+v", newRS)
	}
	if oldRS == nil || oldRS.Replicas != 2 {
		t.Fatalf("expected old RS replicas=2 (headroom-driven scale-down), got %+v", oldRS)
	}
}

func TestRollingRespectsMaxUnavailable(t *testing.T) {
	// surge=0, unavail=1, desired=3, oldReady=3, newReady=0.
	// Phase 1: available=3, floor=2, scaleDownBy=1 -> oldTarget=2.
	// Phase 2: newTarget = 3+0-2 = 1.
	// With surge=0 the old RS must scale DOWN first to free budget for new.
	s, ro, status, oldHash, newHash := setupRollingSync(t, 0, 1)

	res, err := s.Sync(context.Background(), ro, status, testutil.InputsReady(3, 0))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	newRS := findRS(res.ReplicaSets, "canary", newHash)
	oldRS := findRS(res.ReplicaSets, "stable", oldHash)
	if oldRS == nil || oldRS.Replicas != 2 {
		t.Fatalf("expected old RS replicas=2 (down from 3 by unavailable=1), got %+v", oldRS)
	}
	if newRS == nil || newRS.Replicas != 1 {
		t.Fatalf("expected new RS replicas=1 (filled the freed budget), got %+v", newRS)
	}
}

// setupRollingSync builds the common fixtures shared by the in-progress
// rolling-update tests: a 3-replica rollout whose desired template (v2)
// differs from the stable RS (v1, 3 ready replicas). Returns the strategy,
// rollout, status (StableReadyReplicas=3), the old (stable) hash, and the
// new (canary) hash. Per-test differences (surge/unavail, inputs, expected
// targets) are supplied by the caller.
func setupRollingSync(t *testing.T, surge, unavail int32) (*Strategy, *rolloutsv1alpha1.Rollout, *rolloutsv1alpha1.RolloutStatus, string, string) {
	t.Helper()
	s := intstr.FromInt32(surge)
	u := intstr.FromInt32(unavail)
	cfg := &rolloutsv1alpha1.RollingStrategy{MaxSurge: &s, MaxUnavailable: &u}
	tmpl1 := EmptyTemplate("v1")
	tmpl2 := EmptyTemplate("v2")
	ro := makeRolloutWithReplicas("r1", tmpl2, 3)
	status := &rolloutsv1alpha1.RolloutStatus{
		StableRS:            "r1-" + hash.Template(tmpl1),
		StableReadyReplicas: 3,
	}
	return NewStrategy(cfg), ro, status, hash.Template(tmpl1), hash.Template(tmpl2)
}

func TestRollingCompletesWhenOldReachesZero(t *testing.T) {
	// surge=1, unavail=0, desired=3, oldReady=0, newReady=3.
	// Phase 1: available=3, floor=3, no headroom -> oldTarget=0.
	// Phase 2: newTarget = 3+1-0 = 4, capped to 3 -> 3.
	// Completion: old=0, newReady>=desired -> ActionComplete.
	//
	// NB: StableRS must point at the OLD template hash (tmpl1), not the new
	// one. Otherwise currentHash==hash and the converged short-circuit fires
	// before the rolling logic runs. In real production at completion time
	// StableRS still names the drained old RS while CanaryRS names the
	// fully-ready new RS — the completion branch is what promotes the
	// canary in place (relabel + reuse name).
	surge := intstr.FromInt32(1)
	unavail := intstr.FromInt32(0)
	cfg := &rolloutsv1alpha1.RollingStrategy{MaxSurge: &surge, MaxUnavailable: &unavail}
	s := NewStrategy(cfg)
	tmpl1 := EmptyTemplate("v1")
	tmpl2 := EmptyTemplate("v2")
	ro := makeRolloutWithReplicas("r1", tmpl2, 3)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS:            "r1-" + hash.Template(tmpl1),
		StableReadyReplicas: 0, // old fully drained
		CanaryRS:            "r1-canary-" + hash.Template(tmpl2),
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.InputsReady(0, 3))
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionComplete {
		t.Fatalf("expected Complete, got %s", res.Action)
	}
	// Completion must reuse the canary RS name and drop the canary label.
	if len(res.ReplicaSets) != 1 {
		t.Fatalf("expected 1 RS action, got %d", len(res.ReplicaSets))
	}
	if res.ReplicaSets[0].Name != "r1-canary-"+hash.Template(tmpl2) {
		t.Fatalf("expected completion to reuse canary RS name, got %q", res.ReplicaSets[0].Name)
	}
	if _, hasCanary := res.ReplicaSets[0].Labels["rollouts.paprika.io/canary"]; hasCanary {
		t.Error("completion must drop the canary label (promote in-place)")
	}
	if res.ReplicaSets[0].Labels["rollouts.paprika.io/stable"] != "true" {
		t.Error("completion must label the RS as stable")
	}
}

func TestRollingConvergedReusesStableRSName(t *testing.T) {
	// After completion, status.StableRS is the just-promoted canary RS name
	// (e.g. "r1-canary-<hash>"). The converged branch must NOT mint a new
	// "<ro>-<hash>" RS — that would orphan the promoted RS and double the pod
	// count. It must reuse status.StableRS verbatim.
	s := NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	tmpl2 := EmptyTemplate("v2")
	ro := makeRollout("r1", tmpl2)
	promotedName := "r1-canary-" + hash.Template(tmpl2)
	status := rolloutsv1alpha1.RolloutStatus{
		StableRS: promotedName,
		CanaryRS: promotedName, // equal — canaryHashFromStatus returns ""
	}

	res, err := s.Sync(context.Background(), ro, &status, testutil.Inputs())
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Action != core.ActionComplete {
		t.Fatalf("expected Complete, got %s", res.Action)
	}
	if len(res.ReplicaSets) != 1 {
		t.Fatalf("expected 1 RS action, got %d", len(res.ReplicaSets))
	}
	if res.ReplicaSets[0].Name != promotedName {
		t.Fatalf("expected converged path to reuse stable RS name %q, got %q (would orphan the promoted RS)", promotedName, res.ReplicaSets[0].Name)
	}
}
