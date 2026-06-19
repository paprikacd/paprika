package pipelines

import (
	"context"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/syncwindow"
)

const manualSyncAnnotation = "paprika.io/manual-sync"

func (r *ApplicationReconciler) syncWindowAllows(
	ctx context.Context,
	app *paprikav1.Application,
	stage string,
	manual bool,
) (bool, syncwindow.Result) {
	_ = ctx
	if r.SyncWindowEvaluator == nil {
		return true, syncwindow.Result{Allowed: true, Reason: "evaluator not configured"}
	}
	if stage == "" {
		stage = r.getTargetStage(app)
	}
	res := r.SyncWindowEvaluator.IsSyncAllowed(app.Spec.SyncWindows, stage, r.currentTime(), manual)
	return res.Allowed, res
}

func syncWindowReason(res syncwindow.Result) string {
	if strings.Contains(strings.ToLower(res.Reason), "invalid sync window") {
		return "Invalid"
	}
	return "Blocked"
}

func (r *ApplicationReconciler) setSyncWindowCondition(
	app *paprikav1.Application,
	status metav1.ConditionStatus,
	reason, message string,
) {
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               "SyncWindow",
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Time{Time: r.currentTime()},
	})
}

func (r *ApplicationReconciler) syncWindowRequeueAfter(next *time.Time) time.Duration {
	if next == nil {
		return defaultRequeue
	}
	d := next.Sub(r.currentTime())
	if d <= 0 {
		return 1 * time.Second
	}
	if d > time.Hour {
		return time.Hour
	}
	return d
}

func (r *ApplicationReconciler) clearManualSyncAnnotation(ctx context.Context, app *paprikav1.Application) error {
	if app.Annotations == nil {
		return nil
	}
	if _, ok := app.Annotations[manualSyncAnnotation]; !ok {
		return nil
	}
	patch := client.MergeFrom(app.DeepCopy())
	delete(app.Annotations, manualSyncAnnotation)
	if err := r.client.Patch(ctx, app, patch); err != nil {
		return fmt.Errorf("clearing manual sync annotation: %w", err)
	}
	return nil
}
