package pipelines

import (
	"context"
	"fmt"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
)

// ConftestEvaluator resolves, compiles, and evaluates ConftestPolicies against rendered
// manifests. Compile errors and missing policies are returned as blocking governance.Violations.
type ConftestEvaluator interface {
	Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error)
}

const (
	conftestConditionType            = "ConftestPassed"
	conftestReasonPassed             = "Passed"
	conftestReasonPassedWithWarnings = "PassedWithWarnings"
	conftestReasonPolicyViolation    = "PolicyViolation"
	conftestReasonPolicyNotReady     = "PolicyNotReady"
	conftestSeverityNotReady         = "not-ready"
)

// runConftestGate evaluates the application's ConftestPolicies against the rendered
// manifests. It is a no-op when the evaluator is nil or no policies are bound. Blocking
// violations abort promotion (fail-closed) and set a ConftestPassed=False condition; the
// release is left non-terminal so the next reconcile retries after the policy/manifest is
// fixed. A non-nil engine error is surfaced as a reconcile error WITHOUT setting a condition.
func (r *ReleaseReconciler) runConftestGate(ctx context.Context, release *paprikav1.Release, app *paprikav1.Application, manifests []*unstructured.Unstructured) error {
	if r.ConftestEvaluator == nil || len(app.Spec.ConftestPolicies) == 0 {
		return nil
	}
	log := logf.FromContext(ctx)

	violations, err := r.ConftestEvaluator.Evaluate(ctx, release.Namespace, app.Spec.ConftestPolicies, manifests)
	if err != nil {
		return fmt.Errorf("evaluate conftest policies: %w", err)
	}

	if blocking := violations.Blocking(); len(blocking) > 0 {
		reason := conftestReasonPolicyViolation
		for _, v := range blocking {
			if v.Severity == conftestSeverityNotReady {
				reason = conftestReasonPolicyNotReady
				break
			}
		}
		r.setReleaseConftestCondition(release, false, reason, blocking[0].Message)
		if r.EventRecorder != nil {
			r.EventRecorder.Eventf(release, corev1.EventTypeWarning, reason, "%s", blocking[0].Message)
		}
		if patchErr := r.patchReleaseStatus(ctx, release, release.Status.Phase); patchErr != nil {
			log.Error(patchErr, "Failed to patch release status after conftest violation",
				"release", release.Name, "namespace", release.Namespace)
		}
		return fmt.Errorf("conftest %s: %s", reason, blocking[0].Message)
	}

	if warnings := violations.Warnings(); len(warnings) > 0 {
		r.setReleaseConftestCondition(release, true, conftestReasonPassedWithWarnings,
			"Conftest checks passed with warnings: "+warnings[0].Message)
	} else {
		r.setReleaseConftestCondition(release, true, conftestReasonPassed, "Conftest checks passed")
	}
	return nil
}

func (r *ReleaseReconciler) setReleaseConftestCondition(release *paprikav1.Release, status bool, reason, message string) {
	conditionStatus := metav1.ConditionFalse
	if status {
		conditionStatus = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&release.Status.Conditions, metav1.Condition{
		Type:               conftestConditionType,
		Status:             conditionStatus,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
}
