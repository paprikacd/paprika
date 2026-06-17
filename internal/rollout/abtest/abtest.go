// Package abtest implements the A/B testing rollout strategy.
package abtest

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

const promoteAnnotation = "paprika.io/promote"

// Strategy implements an A/B test rollout.
type Strategy struct {
	cfg *rolloutsv1alpha1.ABTestStrategy
}

// NewStrategy creates a new A/B test strategy.
func NewStrategy(cfg *rolloutsv1alpha1.ABTestStrategy) *Strategy {
	if cfg == nil {
		cfg = &rolloutsv1alpha1.ABTestStrategy{}
	}
	return &Strategy{cfg: cfg}
}

// Type returns the strategy type.
func (s *Strategy) Type() string { return "ABTest" }

// Cleanup is a no-op for the A/B test strategy.
func (s *Strategy) Cleanup(_ context.Context, _ *rolloutsv1alpha1.Rollout) error {
	return nil
}

// Sync computes the desired ReplicaSets for an A/B test rollout.
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*core.SyncResult, error) {
	if err := s.validate(); err != nil {
		return nil, err
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

	if _, promoted := ro.Annotations[promoteAnnotation]; promoted {
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
		Message: fmt.Sprintf("A/B routes active: %d", len(s.cfg.Routes)),
		ReplicaSets: []core.ReplicaSetAction{
			makeStableRS(ro, stableHash, desiredReplicas),
			makeCanaryRS(ro, hash, desiredReplicas),
		},
	}, nil
}

func (s *Strategy) validate() error {
	if s.cfg == nil || len(s.cfg.Routes) == 0 {
		return errors.New("abTest strategy requires at least one route")
	}
	for _, route := range s.cfg.Routes {
		if route.Type == "" {
			return errors.New("abTest route type is required")
		}
		if route.Name == "" {
			return errors.New("abTest route name is required")
		}
		if route.Value == "" {
			return errors.New("abTest route value is required")
		}
		if route.Service != "stable" && route.Service != "canary" {
			return errors.New("abTest route service must be stable or canary")
		}
	}
	return nil
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
