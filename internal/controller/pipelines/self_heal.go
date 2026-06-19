package pipelines

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
	selfHealConditionType   = "SelfHealed"
	defaultSelfHealCooldown = 5 * time.Minute
	rollbackAction          = "rollback"
)

func (r *ApplicationReconciler) currentTime() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

//nolint:cyclop // self-heal branching is inherent to the flow.
func (r *ApplicationReconciler) reconcileSelfHeal(ctx context.Context, app *paprikav1.Application) error {
	if app.Spec.SelfHeal == nil {
		return nil
	}

	if !r.selfHealAllowedPhase(app.Status.Phase) {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "PhaseBlocked",
			fmt.Sprintf("Phase %s does not allow self-heal", app.Status.Phase))
		return nil
	}

	if r.selfHealOnCooldown(app) {
		return nil
	}

	if r.SyncWindowEvaluator != nil {
		res := r.SyncWindowEvaluator.IsSyncAllowed(
			app.Spec.SyncWindows, r.getTargetStage(app), r.currentTime(), false)
		if !res.Allowed {
			r.setSelfHealCondition(app, metav1.ConditionFalse, "SyncWindowBlocked", res.Reason)
			r.setSyncWindowCondition(app, metav1.ConditionFalse, syncWindowReason(res), res.Reason)
			return nil
		}
	}

	if app.Spec.SelfHeal.AutoSyncOnDrift && app.Spec.SyncPolicy == paprikav1.SyncAuto && app.Status.OutOfSync > 0 {
		return r.selfHealDriftSync(ctx, app)
	}

	if app.Spec.SelfHeal.AutoRevertOnHealthFailure && app.Status.Health == paprikav1.HealthDegraded {
		return r.selfHealHealthRevert(ctx, app)
	}

	r.setSelfHealCondition(app, metav1.ConditionFalse, "NoActionNeeded", "No drift or health failure detected")
	return nil
}

func (r *ApplicationReconciler) selfHealAllowedPhase(phase paprikav1.ApplicationPhase) bool {
	switch phase {
	case paprikav1.ApplicationHealthy, paprikav1.ApplicationDegraded, paprikav1.ApplicationFailed:
		return true
	case paprikav1.ApplicationPending, paprikav1.ApplicationBuilding, paprikav1.ApplicationPromoting,
		paprikav1.ApplicationCanarying, paprikav1.ApplicationVerifying, paprikav1.ApplicationRolledBack:
		return false
	}
	return false
}

func (r *ApplicationReconciler) selfHealCooldown(app *paprikav1.Application) time.Duration {
	if app.Spec.SelfHeal.Cooldown == "" {
		return defaultSelfHealCooldown
	}
	if d, err := time.ParseDuration(app.Spec.SelfHeal.Cooldown); err == nil && d > 0 {
		return d
	}
	return defaultSelfHealCooldown
}

func (r *ApplicationReconciler) selfHealOnCooldown(app *paprikav1.Application) bool {
	if app.Status.LastSelfHealTime == nil {
		return false
	}
	cooldown := r.selfHealCooldown(app)
	elapsed := r.currentTime().Sub(app.Status.LastSelfHealTime.Time)
	if elapsed >= cooldown {
		return false
	}
	r.setSelfHealCondition(app, metav1.ConditionFalse, "CooldownActive",
		fmt.Sprintf("Cooldown of %v remaining", cooldown-elapsed))
	return true
}

func (r *ApplicationReconciler) selfHealDriftSync(ctx context.Context, app *paprikav1.Application) error {
	if app.Status.ReleaseRef == "" {
		return nil
	}

	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		if client.IgnoreNotFound(err) == nil {
			return nil
		}
		return fmt.Errorf("fetching release for drift sync: %w", err)
	}

	if release.Status.Phase != paprikav1.ReleaseComplete {
		return nil
	}
	if _, ok := release.Annotations[resyncAnnotation]; ok {
		r.setSelfHealCondition(app, metav1.ConditionTrue, "DriftDetected", "Out-of-sync resources detected; triggered re-sync")
		return nil
	}

	patch := client.MergeFrom(release.DeepCopy())
	if release.Annotations == nil {
		release.Annotations = map[string]string{}
	}
	release.Annotations[resyncAnnotation] = strconv.FormatInt(r.currentTime().Unix(), 10)
	if err := r.client.Patch(ctx, &release, patch); err != nil {
		return fmt.Errorf("annotating release for resync: %w", err)
	}

	now := metav1.Time{Time: r.currentTime()}
	app.Status.LastSelfHealTime = &now
	r.recordEvent(app, "Warning", "SelfHealDriftSync", "Out-of-sync resources detected; triggered re-sync")
	r.setSelfHealCondition(app, metav1.ConditionTrue, "DriftDetected", "Out-of-sync resources detected; triggered re-sync")
	return nil
}

func (r *ApplicationReconciler) selfHealHealthRevert(ctx context.Context, app *paprikav1.Application) error {
	if app.Status.ReleaseRef == "" {
		return nil
	}

	var release paprikav1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		if client.IgnoreNotFound(err) == nil {
			return nil
		}
		return fmt.Errorf("fetching release for health revert: %w", err)
	}

	if release.Status.Phase != paprikav1.ReleaseComplete {
		return nil
	}
	if release.Spec.OnFailure == nil || release.Spec.OnFailure.Action != rollbackAction {
		return nil
	}
	if _, ok := release.Annotations[rollbackAnnotation]; ok {
		return nil
	}

	patch := client.MergeFrom(release.DeepCopy())
	if release.Annotations == nil {
		release.Annotations = map[string]string{}
	}
	release.Annotations[rollbackAnnotation] = strconv.FormatInt(r.currentTime().Unix(), 10)
	if err := r.client.Patch(ctx, &release, patch); err != nil {
		return fmt.Errorf("annotating release for rollback: %w", err)
	}

	now := metav1.Time{Time: r.currentTime()}
	app.Status.LastSelfHealTime = &now
	r.recordEvent(app, "Warning", "SelfHealRevert", "Application health degraded; requested rollback")
	r.setSelfHealCondition(app, metav1.ConditionTrue, "HealthDegraded", "Application health degraded; requested rollback")
	return nil
}

func (r *ApplicationReconciler) setSelfHealCondition(app *paprikav1.Application, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               selfHealConditionType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Time{Time: r.currentTime()},
	})
}
