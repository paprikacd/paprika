// Package mirror implements the traffic mirroring rollout strategy.
package mirror

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

// Strategy implements a traffic mirror rollout.
type Strategy struct {
	cfg *rolloutsv1alpha1.MirrorStrategy
}

// NewStrategy creates a new Mirror strategy.
func NewStrategy(cfg *rolloutsv1alpha1.MirrorStrategy) *Strategy {
	if cfg == nil {
		cfg = &rolloutsv1alpha1.MirrorStrategy{}
	}
	return &Strategy{cfg: cfg}
}

// Type returns the strategy type.
func (s *Strategy) Type() string { return "Mirror" }

// Cleanup is a no-op for the Mirror strategy.
func (s *Strategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error {
	return nil
}

// Sync computes the desired ReplicaSets for a mirror rollout.
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, _ core.SyncInputs) (*core.SyncResult, error) {
	if s.cfg == nil {
		return nil, errors.New("mirror strategy requires configuration")
	}
	if s.cfg.MirrorPercent < 1 || s.cfg.MirrorPercent > 100 {
		return nil, errors.New("mirrorPercent must be between 1 and 100")
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
	previewReplicas := int32(1)
	if desiredReplicas > 1 {
		previewReplicas = desiredReplicas / 4
		if previewReplicas < 1 {
			previewReplicas = 1
		}
	}

	if status.CanaryRS == "" {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionStep,
			Message: "Creating canary ReplicaSet for mirroring",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, stableHash, desiredReplicas),
				makeCanaryRS(ro, hash, previewReplicas),
			},
		}, nil
	}

	if _, aborted := ro.Annotations[core.AbortAnnotation]; aborted {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Mirror aborted; stable ReplicaSet retained",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, stableHash, desiredReplicas),
			},
		}, nil
	}

	if _, promoted := ro.Annotations[core.PromoteAnnotation]; promoted {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionPromote,
			Message: "Promoting canary to stable",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhasePaused,
		Action:  core.ActionPause,
		Message: fmt.Sprintf("Mirroring %d%% of traffic", s.cfg.MirrorPercent),
		ReplicaSets: []core.ReplicaSetAction{
			makeStableRS(ro, stableHash, desiredReplicas),
			makeCanaryRS(ro, hash, previewReplicas),
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
