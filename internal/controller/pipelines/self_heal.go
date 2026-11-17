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
	original := app
	app = effectiveDeploymentApp(app)
	if app != original {
		defer func() {
			original.Status.Conditions = app.Status.Conditions
			original.Status.LastSelfHealTime = app.Status.LastSelfHealTime
		}()
	}
	if app.Spec.SelfHeal == nil {
		return nil
	}
	if applicationDiffUnavailable(app) {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "TargetStateUnavailable", "Self-heal waits until the current deployment cluster can be observed.")
		return nil
	}

	if !r.selfHealAllowedPhase(app.Status.Phase) {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "PhaseBlocked",
			fmt.Sprintf("Phase %s does not allow self-heal", app.Status.Phase))
		return nil
	}

	// Self-heal mutates without an operator asking, so it is its own grant. A
	// cluster that permits Apply but not SelfHeal still deploys; it just does not
	// repair itself behind the operator's back.
	if err := r.selfHealPolicyError(ctx, app); err != nil {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "ManagementPolicyWithheld", err.Error())
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
		if !healthFailureThresholdReached(app, r.currentTime()) {
			r.setSelfHealCondition(app, metav1.ConditionFalse, "HealthFailureThresholdPending",
				fmt.Sprintf("Waiting for %d consecutive failed observations of one health check", app.Spec.SelfHeal.HealthFailureThreshold))
			return nil
		}
		return r.selfHealHealthRevert(ctx, app)
	}

	r.setSelfHealCondition(app, metav1.ConditionFalse, "NoActionNeeded", "No drift or health failure detected")
	return nil
}

// selfHealPolicyError reports whether the current deployment target permits
// self-heal. An Application with no stages has no target and no self-heal to
// guard, so it is allowed and the rest of reconcile decides.
func (r *ApplicationReconciler) selfHealPolicyError(ctx context.Context, app *paprikav1.Application) error {
	deployment := effectiveDeploymentApp(app)
	if len(deployment.Spec.Stages) == 0 {
		return nil
	}
	policies, err := r.policiesForApplicationStage(ctx, &deployment.Spec.Stages[0], app.Namespace)
	if err != nil {
		return err
	}
	if policies.allows(paprikav1.ManagementPolicySelfHeal) {
		return nil
	}
	return policies.refusal(paprikav1.ManagementPolicySelfHeal)
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
	// The message must not carry the remaining time. Reconcile already requeues
	// every few seconds, so a countdown here differs on every pass; each pass
	// writes the status, every status write is a watch event, and the event
	// schedules another reconcile. The controller then spins on its own status
	// — an Application in cooldown was reconciling about twice a second instead
	// of once per requeue, and it never settles until the cooldown ends.
	//
	// Both values below are fixed for the life of a cooldown window, so the
	// condition is written once and left alone. The remaining time is still
	// derivable: status.lastSelfHealTime plus this cooldown.
	r.setSelfHealCondition(app, metav1.ConditionFalse, "CooldownActive",
		fmt.Sprintf("Self-heal cooldown of %s since %s", cooldown,
			app.Status.LastSelfHealTime.UTC().Format(time.RFC3339)))
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
	if _, pending := release.Annotations[rollbackAnnotation]; pending {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "ActionPending", "A rollback request is already pending for this release")
		return nil
	}
	if _, ok := release.Annotations[resyncAnnotation]; ok {
		r.setSelfHealCondition(app, metav1.ConditionTrue, "DriftDetected", "Out-of-sync resources detected; triggered re-sync")
		return nil
	}

	patch := client.MergeFromWithOptions(release.DeepCopy(), client.MergeFromWithOptimisticLock{})
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

	if !releaseAllowsHealthRevert(&release) {
		return nil
	}
	if _, pending := release.Annotations[resyncAnnotation]; pending {
		r.setSelfHealCondition(app, metav1.ConditionFalse, "ActionPending", "A re-sync request is already pending for this release")
		return nil
	}
	if _, ok := release.Annotations[rollbackAnnotation]; ok {
		return nil
	}

	patch := client.MergeFromWithOptions(release.DeepCopy(), client.MergeFromWithOptimisticLock{})
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

func releaseAllowsHealthRevert(release *paprikav1.Release) bool {
	return release.Status.Phase == paprikav1.ReleaseComplete && release.Spec.OnFailure != nil && release.Spec.OnFailure.Action == rollbackAction
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
