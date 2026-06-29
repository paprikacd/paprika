// Package bluegreen implements the Blue/Green rollout strategy.
package bluegreen

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

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
func (s *Strategy) Sync(_ context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, in core.SyncInputs) (*core.SyncResult, error) {
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

	if core.IsAborted(ro, status) {
		return core.AbortResult(ro, status, hashFromRSName(status.StableRS), desiredReplicas), nil
	}

	activeHash := hashFromRSName(status.StableRS)

	// Already-promoted path: drain the previous active RS after ScaleDownDelaySeconds.
	if res, err := s.drainResult(ro, status, hash, desiredReplicas, in); res != nil || err != nil {
		return res, err
	}

	// First time seeing the new template: create preview.
	if status.CanaryRS == "" {
		if hash == activeHash {
			return &core.SyncResult{
				Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
				Action:  core.ActionComplete,
				Message: "Active ReplicaSet matches desired template",
				ReplicaSets: []core.ReplicaSetAction{
					makeActiveRS(ro, hash, desiredReplicas),
				},
			}, nil
		}
		previewReplicas := desiredReplicas
		if s.cfg.PreviewReplicaCount != nil {
			previewReplicas = *s.cfg.PreviewReplicaCount
		}
		// Reset PreviewHealthyAt for the new preview; the controller re-stamps it
		// once the new preview becomes fully ready.
		status.PreviewHealthyAt = nil
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

	previewHash := hashFromRSName(status.CanaryRS)

	// Auto-promote: if AutoPromotionSeconds is set and preview has been healthy
	// for at least that long, promote without an annotation.
	if s.cfg.AutoPromotionSeconds != nil && *s.cfg.AutoPromotionSeconds > 0 &&
		status.PreviewHealthyAt != nil &&
		in.Now().Sub(status.PreviewHealthyAt.Time) >= time.Duration(*s.cfg.AutoPromotionSeconds)*time.Second {
		return promoteResult(ro, status, hash, activeHash, desiredReplicas, in)
	}

	// Manual promote.
	if _, promoted := ro.Annotations[core.PromoteAnnotation]; promoted {
		return promoteResult(ro, status, hash, activeHash, desiredReplicas, in)
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
			makePreviewRS(ro, previewHash, previewReplicas),
		},
	}, nil
}

// drainResult handles the post-promotion drain phase. It returns a non-nil
// result when the rollout is mid-drain (PromotedAt set + PreviousActiveRS set),
// or (nil, nil) when the rollout is not in that phase.
//
// The controller observes the PreviousActiveRS's ready count onto
// CanaryReadyReplicas during drain. When it reaches 0, this clears
// PreviousActiveRS + PromotedAt and returns Complete so a fresh template bump
// can start a new rollout. Otherwise it scales the previous active RS to 0 once
// ScaleDownDelaySeconds has elapsed.
func (s *Strategy) drainResult(ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, hash string, desiredReplicas int32, in core.SyncInputs) (*core.SyncResult, error) {
	if status.PromotedAt == nil || status.PreviousActiveRS == "" {
		return nil, nil
	}
	if in.CanaryReadyReplicas == 0 {
		status.PreviousActiveRS = ""
		status.PromotedAt = nil
		return &core.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
			Action:  core.ActionComplete,
			Message: "Active ReplicaSet matches desired template; previous active drained",
			ReplicaSets: []core.ReplicaSetAction{
				makeActiveRS(ro, hash, desiredReplicas),
			},
		}, nil
	}
	delay := int32(30)
	if s.cfg.ScaleDownDelaySeconds != nil {
		delay = *s.cfg.ScaleDownDelaySeconds
	}
	oldTarget := desiredReplicas
	if in.Now().Sub(status.PromotedAt.Time) >= time.Duration(delay)*time.Second {
		oldTarget = 0
	}
	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
		Action:  core.ActionStep,
		Message: fmt.Sprintf("Draining previous active; target=%d", oldTarget),
		ReplicaSets: []core.ReplicaSetAction{
			makeActiveRS(ro, hash, desiredReplicas),
			{
				Name:     status.PreviousActiveRS,
				Replicas: oldTarget,
				Template: nil, // do not overwrite the old RS template
				Labels: map[string]string{
					"rollouts.paprika.io/draining": "true",
					"rollouts.paprika.io/revision": hashFromRSName(status.PreviousActiveRS),
					"rollouts.paprika.io/rollout":  ro.Name,
				},
			},
		},
	}, nil
}

// promoteResult produces a promote SyncResult. Side effects on `status`:
//   - PromotedAt is stamped (using the injected clock, NOT time.Now()) if nil.
//   - PreviousActiveRS is set to the current StableRS (the old active).
//   - StableRS is advanced to the new active RS name.
//   - CanaryRS is cleared (the preview RS is being promoted to active).
//
// The old active RS is returned with label "draining=true" (not "stable" or
// "active") so the controller's updateStatusFromResult does NOT mistake it for
// the current StableRS.
func promoteResult(ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, hash, activeHash string, desiredReplicas int32, in core.SyncInputs) (*core.SyncResult, error) {
	if status.PromotedAt == nil {
		now := metav1.NewTime(in.Now())
		status.PromotedAt = &now
	}
	// Track the prior active RS for the drain phase.
	if status.StableRS != "" && hashFromRSName(status.StableRS) != hash {
		status.PreviousActiveRS = status.StableRS
	}
	status.StableRS = ro.Name + "-active-" + hash
	status.CanaryRS = "" // preview is being promoted to active
	status.PreviewHealthyAt = nil
	return &core.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
		Action:  core.ActionPromote,
		Message: "Promoting preview to active",
		ReplicaSets: []core.ReplicaSetAction{
			makeActiveRS(ro, hash, desiredReplicas),
			{
				Name:     ro.Name + "-active-" + activeHash,
				Replicas: desiredReplicas, // keep at full count; drain phase will scale it down
				Template: nil,             // do not overwrite the old RS template
				Labels: map[string]string{
					"rollouts.paprika.io/draining": "true",
					"rollouts.paprika.io/revision": activeHash,
					"rollouts.paprika.io/rollout":  ro.Name,
				},
			},
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
