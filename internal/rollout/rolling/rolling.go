// Package rolling implements the Rolling rollout strategy.
package rolling

import (
	"context"
	"strings"

	corev1 "k8s.io/api/core/v1"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

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
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, _ core.SyncInputs) (*core.SyncResult, error) {
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

	currentHash := hashFromRSName(status.StableRS)
	if currentHash == hash {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Stable ReplicaSet matches desired template",
			ReplicaSets: []core.ReplicaSetAction{
				makeStableRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
		Action:  core.ActionCreateStable,
		Message: "Replacing stable ReplicaSet with new revision",
		ReplicaSets: []core.ReplicaSetAction{
			{
				Name:     status.StableRS,
				Replicas: 0,
				Template: &ro.Spec.Template,
				Labels: map[string]string{
					"rollouts.paprika.io/stable":   "true",
					"rollouts.paprika.io/revision": currentHash,
				},
			},
			makeStableRS(ro, hash, desiredReplicas),
		},
	}, nil
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
