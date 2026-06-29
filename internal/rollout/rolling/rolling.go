// Package rolling implements the Rolling rollout strategy.
package rolling

import (
	"context"
	"fmt"
	"math"
	"strings"

	corev1 "k8s.io/api/core/v1"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
)

// Strategy implements a simple rolling update.
type Strategy struct {
	cfg *rolloutsv1alpha1.RollingStrategy
}

// NewStrategy creates a new Rolling strategy.
func NewStrategy(cfg *rolloutsv1alpha1.RollingStrategy) *Strategy {
	if cfg == nil {
		cfg = &rolloutsv1alpha1.RollingStrategy{}
	}
	return &Strategy{cfg: cfg}
}

// Type returns the strategy type.
func (s *Strategy) Type() string { return "Rolling" }

// Cleanup is a no-op for the Rolling strategy.
func (s *Strategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error {
	return nil
}

// Sync computes the desired ReplicaSets for a rolling update.
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, in core.SyncInputs) (*core.SyncResult, error) {
	desiredReplicas := int32(1)
	if ro.Spec.Replicas != nil {
		desiredReplicas = *ro.Spec.Replicas
	}
	hash := hash.Template(&ro.Spec.Template)

	if status.StableRS == "" {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionCreateStable,
			Message: "Creating stable ReplicaSet",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	// Honor abort even though Rolling has no canary RS — the rollout freezes.
	if core.IsAborted(ro, status) {
		return core.AbortResult(ro, status, hashFromRSName(status.StableRS), desiredReplicas), nil
	}

	currentHash := hashFromRSName(status.StableRS)
	newRSHash := canaryHashFromStatus(status)

	// Stable RS already matches the desired template and no in-flight
	// canary RS exists. The rollout is converged. Reuse the existing
	// StableRS name (it may be `<ro>-<hash>` from initial creation or
	// `<ro>-canary-<hash>` from a just-completed rollout's in-place
	// promotion) so we don't mint a phantom duplicate.
	if currentHash == hash && (newRSHash == "" || newRSHash == hash) {
		stableName := status.StableRS
		if stableName == "" {
			stableName = ro.Name + "-" + hash
		}
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Stable ReplicaSet matches desired template",
			ReplicaSets: []core.ReplicaSetAction{
				{
					Name:     stableName,
					Replicas: desiredReplicas,
					Template: &ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/stable":   "true",
						"rollouts.paprika.io/revision": hash,
						"rollouts.paprika.io/rollout":  ro.Name,
					},
				},
			},
		}, nil
	}

	return s.rollingUpdate(ro, status, in, hash, currentHash, desiredReplicas), nil
}

// rollingUpdate computes the two-phase scale-down/scale-up targets and emits
// either the completion action (canary promoted to stable) or the in-progress
// pair of RS actions.
func (s *Strategy) rollingUpdate(
	ro *rolloutsv1alpha1.Rollout,
	status *rolloutsv1alpha1.RolloutStatus,
	in core.SyncInputs,
	hash, currentHash string,
	desiredReplicas int32,
) *core.SyncResult {
	// Resolve surge/unavailable from intstr (percentages evaluated against desiredReplicas).
	surge := resolveCount(s.cfg.MaxSurge, desiredReplicas)
	unavailable := resolveCount(s.cfg.MaxUnavailable, desiredReplicas)
	// Guard against an invalid spec the webhook somehow let through.
	if surge == 0 && unavailable == 0 {
		surge = 1 // K8s Deployment controller does the same to avoid deadlock.
	}

	// Readiness comes from SyncInputs (populated by the controller's
	// observeReadyReplicas, or by tests via testutil.InputsReady).
	oldReady := in.StableReadyReplicas
	if oldReady > desiredReplicas {
		oldReady = desiredReplicas
	}
	newReady := in.CanaryReadyReplicas

	// Two-phase rolling update (mirrors K8s Deployment controller semantics):
	//
	// Phase 1 — scale down the old RS as far as the availability floor allows.
	//   available = newReady + oldReady
	//   floor     = desired - unavailable
	//   We can remove (available - floor) pods from old, capped at oldReady.
	//
	// Phase 2 — scale up the new RS using the freed budget.
	//   Total budget = desired + surge (the surge invariant).
	//   newTarget = (desired + surge) - oldTarget, capped to [newReady, desired].
	//
	// This formulation correctly handles:
	//   - surge > 0: new RS scales up first, old scales down as new becomes ready.
	//   - surge = 0, unavailable > 0: old scales down first (one pod at a time),
	//     new scales up to fill the gap. No deadlock.
	floor := desiredReplicas - unavailable
	if floor < 0 {
		floor = 0
	}
	available := newReady + oldReady

	oldTarget := oldReady
	if available > floor {
		scaleDownBy := available - floor
		if scaleDownBy > oldReady {
			scaleDownBy = oldReady
		}
		oldTarget = oldReady - scaleDownBy
		if oldTarget < 0 {
			oldTarget = 0
		}
	}

	newTarget := desiredReplicas + surge - oldTarget
	if newTarget > desiredReplicas {
		newTarget = desiredReplicas
	}
	if newTarget < newReady {
		newTarget = newReady // don't scale down what's already up
	}

	// Completion: old fully scaled down, new at desired, new fully ready.
	// PROMOTE the canary RS to stable in place: reuse its name (so the
	// controller updates the existing RS — no orphaned canary RS) and drop
	// the canary=true label while adding stable=true.
	if oldTarget == 0 && newReady >= desiredReplicas {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Rolling update complete",
			ReplicaSets: []core.ReplicaSetAction{
				{
					Name:     ro.Name + "-canary-" + hash,
					Replicas: desiredReplicas,
					Template: &ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/stable":   "true", // promoted
						"rollouts.paprika.io/revision": hash,
						"rollouts.paprika.io/rollout":  ro.Name,
						// NB: canary=true is intentionally absent.
					},
				},
			},
		}
	}

	// In-progress: emit the old RS (labelled stable, parked on StableRS) and
	// the new RS (labelled canary, parked on CanaryRS). The controller's
	// updateStatusFromResult keeps StableRS pointing at the old RS until the
	// completion branch above promotes the canary.
	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
		Action:  core.ActionCreateStable,
		Message: fmt.Sprintf("Rolling update in progress: new target=%d ready=%d, old target=%d ready=%d", newTarget, newReady, oldTarget, oldReady),
		ReplicaSets: []core.ReplicaSetAction{
			{
				Name:     status.StableRS,
				Replicas: oldTarget,
				Template: nil, // do not overwrite the old RS's template
				Labels: map[string]string{
					"rollouts.paprika.io/stable":   "true",
					"rollouts.paprika.io/revision": currentHash,
					"rollouts.paprika.io/rollout":  ro.Name,
				},
			},
			makeCanaryRS(ro, hash, newTarget),
		},
	}
}

// canaryHashFromStatus returns the template hash of the in-flight canary RS,
// or "" if no distinct canary RS exists (CanaryRS empty or equal to StableRS).
func canaryHashFromStatus(status *rolloutsv1alpha1.RolloutStatus) string {
	if status.CanaryRS == "" || status.CanaryRS == status.StableRS {
		return ""
	}
	return hashFromRSName(status.CanaryRS)
}

// makeCanaryRS labels the in-flight new RS as canary during a rolling update.
// The controller's updateStatusFromResult parks it on status.CanaryRS, while
// status.StableRS keeps pointing at the old RS — this is what allows the
// strategy's surge/unavailable accounting to observe both.
func makeCanaryRS(ro *rolloutsv1alpha1.Rollout, hash string, replicas int32) core.ReplicaSetAction {
	return core.ReplicaSetAction{
		Name:     ro.Name + "-canary-" + hash,
		Replicas: replicas,
		Template: &ro.Spec.Template,
		Labels: map[string]string{
			"rollouts.paprika.io/canary":   "true",
			"rollouts.paprika.io/revision": hash,
			"rollouts.paprika.io/rollout":  ro.Name,
		},
	}
}

// resolveCount turns an intstr.IntOrString into an int32 against the desired
// replica count. Supports integers and percent strings like "25%".
func resolveCount(v *intstr.IntOrString, desired int32) int32 {
	if v == nil {
		return 0
	}
	resolved, err := intstr.GetScaledValueFromIntOrPercent(v, int(desired), true)
	if err != nil || resolved < 0 {
		return 0
	}
	if resolved > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(resolved)
}

func makeStableRS(ro *rolloutsv1alpha1.Rollout, hash string, replicas int32) core.ReplicaSetAction {
	return core.ReplicaSetAction{
		Name:     ro.Name + "-" + hash,
		Replicas: replicas,
		Template: &ro.Spec.Template,
		Labels: map[string]string{
			"rollouts.paprika.io/stable":   "true",
			"rollouts.paprika.io/revision": hash,
			"rollouts.paprika.io/rollout":  ro.Name,
		},
	}
}

func hashFromRSName(name string) string {
	if idx := strings.LastIndex(name, "-"); idx >= 0 {
		return name[idx+1:]
	}
	return ""
}

// EmptyTemplate returns a minimal PodTemplateSpec for tests.
func EmptyTemplate(name string) *corev1.PodTemplateSpec {
	return &corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": name}},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "app", Image: "nginx"}},
		},
	}
}
