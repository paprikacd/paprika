package pipelines

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

const analysisRunNameFmt = "%s-%s-analysis"

func analysisRunName(appName, templateName string) string {
	return fmt.Sprintf(analysisRunNameFmt, appName, templateName)
}

func (r *ApplicationReconciler) reconcileAnalysisRuns(ctx context.Context, app *pipelinesv1alpha1.Application) error {
	log := log.FromContext(ctx)

	desiredRuns := map[string]bool{}
	for _, ref := range app.Spec.AnalysisTemplates {
		runName := analysisRunName(app.Name, ref.Name)
		desiredRuns[runName] = true
		if err := r.ensureAnalysisRun(ctx, app, ref, runName); err != nil {
			log.Error(err, "Failed to ensure AnalysisRun", "run", runName)
			continue
		}
	}

	if err := r.deleteStaleAnalysisRuns(ctx, app, desiredRuns); err != nil {
		log.Error(err, "Failed to delete stale analysis runs")
	}

	results, err := r.aggregateAnalysisResults(ctx, app)
	if err != nil {
		return fmt.Errorf("aggregating analysis results: %w", err)
	}
	app.Status.AnalysisResults = results

	if err := r.handleAnalysisFailure(ctx, app); err != nil {
		log.Error(err, "Failed to handle analysis failure")
	}

	r.setAnalysisCondition(app)
	return nil
}

func argsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func (r *ApplicationReconciler) ensureAnalysisRun(ctx context.Context, app *pipelinesv1alpha1.Application, ref pipelinesv1alpha1.AnalysisTemplateRef, runName string) error {
	var existing pipelinesv1alpha1.AnalysisRun
	err := r.client.Get(ctx, types.NamespacedName{Name: runName, Namespace: app.Namespace}, &existing)
	if client.IgnoreNotFound(err) != nil {
		return fmt.Errorf("getting analysisrun %s: %w", runName, err)
	}
	if err == nil {
		if existing.Spec.IntervalSeconds != ref.IntervalSeconds || !argsEqual(existing.Spec.Args, ref.Args) {
			existing.Spec.IntervalSeconds = ref.IntervalSeconds
			existing.Spec.Args = ref.Args
			if updateErr := r.client.Update(ctx, &existing); updateErr != nil {
				return fmt.Errorf("updating analysisrun %s: %w", runName, updateErr)
			}
		}
		return nil
	}

	run := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{
			Name:      runName,
			Namespace: app.Namespace,
			Labels: withProjectLabels(app, map[string]string{
				engine.ApplicationNameLabelKey:     app.Name,
				"app.paprika.io/analysis-template": ref.Name,
			}),
		},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:     ref.Name,
			ApplicationRef:  app.Name,
			Args:            ref.Args,
			IntervalSeconds: ref.IntervalSeconds,
		},
	}
	if err := ctrl.SetControllerReference(app, run, r.Scheme); err != nil {
		return fmt.Errorf("setting controller reference: %w", err)
	}
	if createErr := r.client.Create(ctx, run); createErr != nil {
		return fmt.Errorf("creating analysisrun %s: %w", runName, createErr)
	}
	return nil
}

func (r *ApplicationReconciler) deleteStaleAnalysisRuns(ctx context.Context, app *pipelinesv1alpha1.Application, desired map[string]bool) error {
	var list pipelinesv1alpha1.AnalysisRunList
	if err := r.client.List(ctx, &list,
		client.InNamespace(app.Namespace),
		client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
	); err != nil {
		return fmt.Errorf("listing analysis runs: %w", err)
	}
	for i := range list.Items {
		run := &list.Items[i]
		if desired[run.Name] {
			continue
		}
		if err := r.client.Delete(ctx, run); client.IgnoreNotFound(err) != nil {
			return fmt.Errorf("deleting analysis run %s: %w", run.Name, err)
		}
	}
	return nil
}

func (r *ApplicationReconciler) aggregateAnalysisResults(ctx context.Context, app *pipelinesv1alpha1.Application) ([]pipelinesv1alpha1.AnalysisResult, error) {
	var list pipelinesv1alpha1.AnalysisRunList
	if err := r.client.List(ctx, &list,
		client.InNamespace(app.Namespace),
		client.MatchingLabels{engine.ApplicationNameLabelKey: app.Name},
	); err != nil {
		return nil, fmt.Errorf("listing analysis runs: %w", err)
	}

	results := make([]pipelinesv1alpha1.AnalysisResult, 0, len(list.Items))
	for i := range list.Items {
		run := &list.Items[i]
		result := pipelinesv1alpha1.AnalysisResult{
			Name:  run.Spec.TemplateRef,
			Phase: run.Status.Phase,
		}
		for j := range run.Status.Results {
			res := &run.Status.Results[j]
			if res.CheckedAt != nil && (result.CheckedAt == nil || res.CheckedAt.After(result.CheckedAt.Time)) {
				result.Passed = res.Passed
				result.Message = res.Message
				result.CheckedAt = res.CheckedAt
			}
		}
		results = append(results, result)
	}
	return results, nil
}

//nolint:cyclop // analysis failure rollback mirrors self-heal rollback guards.
func (r *ApplicationReconciler) handleAnalysisFailure(ctx context.Context, app *pipelinesv1alpha1.Application) error {
	if app.Status.ReleaseRef == "" {
		return nil
	}
	if app.Status.Phase != pipelinesv1alpha1.ApplicationHealthy && app.Status.Phase != pipelinesv1alpha1.ApplicationDegraded {
		return nil
	}

	var release pipelinesv1alpha1.Release
	if err := r.client.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return fmt.Errorf("fetching release for analysis failure: %w", err)
		}
		return nil
	}
	if release.Status.Phase != pipelinesv1alpha1.ReleaseComplete {
		return nil
	}
	if _, ok := release.Annotations[rollbackAnnotation]; ok {
		return nil
	}

	for _, ref := range app.Spec.AnalysisTemplates {
		runName := analysisRunName(app.Name, ref.Name)
		var run pipelinesv1alpha1.AnalysisRun
		if err := r.client.Get(ctx, types.NamespacedName{Name: runName, Namespace: app.Namespace}, &run); err != nil {
			continue
		}
		if run.Status.Phase != pipelinesv1alpha1.AnalysisRunFailed {
			continue
		}
		if ref.OnFailure == nil || ref.OnFailure.Action != rollbackAction {
			continue
		}

		if release.Annotations == nil {
			release.Annotations = map[string]string{}
		}
		release.Annotations[rollbackAnnotation] = metav1.Now().String()
		if err := r.client.Update(ctx, &release); err != nil {
			return fmt.Errorf("annotating release for rollback: %w", err)
		}
		r.recordEvent(app, corev1.EventTypeWarning, "AnalysisFailureRollback", fmt.Sprintf("Analysis %s failed; requested rollback", ref.Name))
		return nil
	}
	return nil
}

func (r *ApplicationReconciler) setAnalysisCondition(app *pipelinesv1alpha1.Application) {
	if len(app.Spec.AnalysisTemplates) == 0 {
		meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
			Type:               "AnalysisFailed",
			Status:             metav1.ConditionFalse,
			Reason:             "NoAnalysisConfigured",
			Message:            "No analysis templates referenced",
			LastTransitionTime: metav1.Now(),
		})
		return
	}

	hasFailed := false
	hasError := false
	for _, res := range app.Status.AnalysisResults {
		switch res.Phase {
		case pipelinesv1alpha1.AnalysisRunFailed:
			hasFailed = true
		case pipelinesv1alpha1.AnalysisRunError:
			hasError = true
		case pipelinesv1alpha1.AnalysisRunPending, pipelinesv1alpha1.AnalysisRunRunning, pipelinesv1alpha1.AnalysisRunSuccessful, pipelinesv1alpha1.AnalysisRunCompleted:
			// No-op for non-failure phases.
		}
	}

	if hasFailed {
		meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
			Type:               "AnalysisFailed",
			Status:             metav1.ConditionTrue,
			Reason:             "AnalysisRunFailed",
			Message:            "One or more analysis runs failed",
			LastTransitionTime: metav1.Now(),
		})
		return
	}
	if hasError {
		meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
			Type:               "AnalysisFailed",
			Status:             metav1.ConditionFalse,
			Reason:             "AnalysisError",
			Message:            "One or more analysis runs are in error",
			LastTransitionTime: metav1.Now(),
		})
		return
	}

	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               "AnalysisFailed",
		Status:             metav1.ConditionFalse,
		Reason:             "AnalysisRunning",
		Message:            "Analysis is running",
		LastTransitionTime: metav1.Now(),
	})
}
