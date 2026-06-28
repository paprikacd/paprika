// Package bluegreen implements the Blue/Green rollout strategy.
package bluegreen

import (
	"context"
	"errors"
	"strings"

	corev1 "k8s.io/api/core/v1"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout/core"
	"github.com/benebsworth/paprika/internal/rollout/hash"
)

// Strategy implements a blue/green rollout.
type Strategy struct {
	cfg *rolloutsv1alpha1.BlueGreenStrategy
}

// NewStrategy creates a new Blue/Green strategy.
func NewStrategy(cfg *rolloutsv1alpha1.BlueGreenStrategy) *Strategy {
	if cfg == nil {
		cfg = &rolloutsv1alpha1.BlueGreenStrategy{}
	}
	return &Strategy{cfg: cfg}
}

// Type returns the strategy type.
func (s *Strategy) Type() string { return "BlueGreen" }

// Cleanup is a no-op for the Blue/Green strategy.
func (s *Strategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error {
	return nil
}

// Sync computes the desired ReplicaSets for a blue/green rollout.
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, _ core.SyncInputs) (*core.SyncResult, error) {
	if s.cfg.ActiveService == "" {
		return nil, errors.New("blueGreen strategy requires activeService")
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
			Message: "Creating active ReplicaSet",
			ReplicaSets: []core.ReplicaSetAction{
				makeActiveRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	activeHash := hashFromRSName(status.StableRS)
	if hash == activeHash && status.CanaryRS == "" {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Active ReplicaSet matches desired template",
			ReplicaSets: []core.ReplicaSetAction{
				makeActiveRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	if status.CanaryRS == "" {
		previewReplicas := desiredReplicas
		if s.cfg.PreviewReplicaCount != nil {
			previewReplicas = *s.cfg.PreviewReplicaCount
		}
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhasePaused,
			Action:  core.ActionPause,
			Message: "Preview ReplicaSet created; waiting for promotion",
			ReplicaSets: []core.ReplicaSetAction{
				makeActiveRS(ro, activeHash, desiredReplicas),
				makePreviewRS(ro, hash, previewReplicas),
			},
		}, nil
	}

	if _, promoted := ro.Annotations[core.PromoteAnnotation]; promoted {
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  core.ActionPromote,
			Message: "Promoting preview to active",
			ReplicaSets: []core.ReplicaSetAction{
				makeActiveRS(ro, hash, desiredReplicas),
			},
		}, nil
	}

	previewReplicas := desiredReplicas
	if s.cfg.PreviewReplicaCount != nil {
		previewReplicas = *s.cfg.PreviewReplicaCount
	}
	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhasePaused,
		Action:  core.ActionPause,
		Message: "Waiting for promotion",
		ReplicaSets: []core.ReplicaSetAction{
			makeActiveRS(ro, activeHash, desiredReplicas),
			makePreviewRS(ro, hash, previewReplicas),
		},
	}, nil
}

func makeActiveRS(ro *rolloutsv1alpha1.Rollout, hash string, replicas int32) core.ReplicaSetAction {
	return core.ReplicaSetAction{
		Name:     ro.Name + "-active-" + hash,
		Replicas: replicas,
		Template: &ro.Spec.Template,
		Labels: map[string]string{
			"rollouts.paprika.io/active":   "true",
			"rollouts.paprika.io/stable":   "true",
			"rollouts.paprika.io/revision": hash,
			"rollouts.paprika.io/rollout":  ro.Name,
		},
	}
}

func makePreviewRS(ro *rolloutsv1alpha1.Rollout, hash string, replicas int32) core.ReplicaSetAction {
	return core.ReplicaSetAction{
		Name:     ro.Name + "-preview-" + hash,
		Replicas: replicas,
		Template: &ro.Spec.Template,
		Labels: map[string]string{
			"rollouts.paprika.io/preview":  "true",
			"rollouts.paprika.io/canary":   "true",
			"rollouts.paprika.io/revision": hash,
			"rollouts.paprika.io/rollout":  ro.Name,
		},
	}
}

func hashFromRSName(name string) string {
	for _, prefix := range []string{"-active-", "-preview-"} {
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
