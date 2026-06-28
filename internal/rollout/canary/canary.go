// Package canary implements the Canary rollout strategy.
package canary

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
)

// Strategy implements a canary rollout.
type Strategy struct {
	cfg *rolloutsv1alpha1.CanaryStrategy
}

// NewStrategy creates a new Canary strategy.
func NewStrategy(cfg *rolloutsv1alpha1.CanaryStrategy) *Strategy {
	return &Strategy{cfg: cfg}
}

// Type returns the strategy type.
func (s *Strategy) Type() string { return "Canary" }

// Cleanup is a no-op for the Canary strategy.
func (s *Strategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error {
	return nil
}

// Sync computes the desired ReplicaSets for a canary rollout.
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, _ core.SyncInputs) (*core.SyncResult, error) {
	if s.cfg == nil || len(s.cfg.Steps) == 0 {
		return nil, errors.New("canary strategy requires at least one step")
	}

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

	stableHash := hashFromRSName(status.StableRS)
	if status.CanaryRS == "" && hash != stableHash {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionStep,
			Message: "Creating canary ReplicaSet",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, stableHash, desiredReplicas),
				makeCanaryRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	if status.CurrentStepIndex >= int32(len(s.cfg.Steps)) {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionPromote,
			Message: "Promoting canary to stable",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	step := s.cfg.Steps[status.CurrentStepIndex]
	stableWeight := int32(100 - step.SetWeight)
	if stableWeight < 0 {
		stableWeight = 0
	}
	canaryWeight := step.SetWeight

	stableReplicas := desiredReplicas * stableWeight / 100
	canaryReplicas := desiredReplicas - stableReplicas
	if canaryReplicas < 1 {
		canaryReplicas = 1
	}

	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
		Action:  core.ActionStep,
		Message: fmt.Sprintf("Canary step %d at weight %d", status.CurrentStepIndex, canaryWeight),
		ReplicaSets: []core.ReplicaSetAction{
			makeStableRS(ro, stableHash, stableReplicas),
			makeCanaryRS(ro, hash, canaryReplicas),
		},
	}, nil
}

func makeStableRS(ro *rolloutsv1alpha1.Rollout, hash string, replicas int32) core.ReplicaSetAction {
	return core.ReplicaSetAction{
		Name:     ro.Name + "-stable-" + hash,
		Replicas: replicas,
		Template: &ro.Spec.Template,
		Labels: map[string]string{
			"rollouts.paprika.io/stable":   "true",
			"rollouts.paprika.io/revision": hash,
			"rollouts.paprika.io/rollout":  ro.Name,
		},
	}
}

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

func hashFromRSName(name string) string {
	for _, prefix := range []string{"-stable-", "-canary-"} {
		if idx := strings.LastIndex(name, prefix); idx >= 0 {
			return name[idx+len(prefix):]
		}
	}
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
