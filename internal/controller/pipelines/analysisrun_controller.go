package pipelines

import (
	"context"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/log"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/analysis"
)

// AnalysisRunReconciler reconciles AnalysisRun resources.
type AnalysisRunReconciler struct {
	client        client.Client
	Scheme        *runtime.Scheme
	Analyzer      Analyzer
	EventRecorder record.EventRecorder
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysisruns/finalizers,verbs=update
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=analysistemplates,verbs=get;list;watch

// Reconcile handles AnalysisRun reconciliation.
func (r *AnalysisRunReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	log.Info("Reconciling AnalysisRun", "namespace", req.Namespace, "name", req.Name)

	var run pipelinesv1alpha1.AnalysisRun
	if err := r.client.Get(ctx, req.NamespacedName, &run); err != nil {
		if client.IgnoreNotFound(err) != nil {
			return ctrl.Result{}, fmt.Errorf("getting analysisrun: %w", err)
		}
		return ctrl.Result{}, nil
	}

	if err := r.reconcileRun(ctx, &run); err != nil {
		return ctrl.Result{}, err
	}

	interval := time.Duration(run.Spec.IntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 60 * time.Second
	}

	if run.Status.Phase == pipelinesv1alpha1.AnalysisRunCompleted {
		return ctrl.Result{}, nil
	}

	return ctrl.Result{RequeueAfter: interval}, nil
}

//nolint:cyclop // analysis run lifecycle transitions are inherently sequential.
func (r *AnalysisRunReconciler) reconcileRun(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun) error {
	template, err := r.resolveTemplate(ctx, run)
	if err != nil {
		return r.markRunError(ctx, run, "TemplateResolutionFailed", err.Error())
	}
	if template == nil {
		return r.markRunError(ctx, run, "TemplateNotFound", fmt.Sprintf("template %q not found", run.Spec.TemplateRef))
	}

	if run.Status.Phase == "" || run.Status.Phase == pipelinesv1alpha1.AnalysisRunPending {
		run.Status.Phase = pipelinesv1alpha1.AnalysisRunRunning
		if run.Status.StartedAt == nil {
			now := metav1.Now()
			run.Status.StartedAt = &now
		}
	}

	args := r.mergeArgs(template.Spec.Args, run.Spec.Args)
	checks := make([]pipelinesv1alpha1.AnalysisCheck, 0, len(template.Spec.Checks))
	for i := range template.Spec.Checks {
		rendered, err := analysis.SubstituteCheck(template.Spec.Checks[i], analysis.SubstituteContext{
			Args:        args,
			Application: run.Spec.ApplicationRef,
			Namespace:   run.Namespace,
		})
		if err != nil {
			return r.markRunError(ctx, run, "SubstitutionFailed", err.Error())
		}
		checks = append(checks, rendered)
	}

	results := r.Analyzer.RunChecks(ctx, checks)
	run.Status.Results = r.convertResults(results)
	run.Status.CyclesExecuted++

	passed := r.allPassed(results)
	if passed {
		run.Status.Phase = pipelinesv1alpha1.AnalysisRunSuccessful
	} else {
		run.Status.Phase = pipelinesv1alpha1.AnalysisRunFailed
	}

	if run.Spec.Count > 0 && run.Status.CyclesExecuted >= run.Spec.Count {
		run.Status.Phase = pipelinesv1alpha1.AnalysisRunCompleted
		now := metav1.Now()
		run.Status.CompletedAt = &now
	}

	if run.Status.Phase == pipelinesv1alpha1.AnalysisRunFailed && run.Spec.TerminateOnFailure {
		now := metav1.Now()
		run.Status.CompletedAt = &now
	}

	if err := r.client.Status().Update(ctx, run); err != nil {
		return fmt.Errorf("updating analysisrun status: %w", err)
	}
	return nil
}

func (r *AnalysisRunReconciler) resolveTemplate(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun) (*pipelinesv1alpha1.AnalysisTemplate, error) {
	var template pipelinesv1alpha1.AnalysisTemplate
	if err := r.client.Get(ctx, types.NamespacedName{Name: run.Spec.TemplateRef, Namespace: run.Namespace}, &template); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("getting analysis template %q: %w", run.Spec.TemplateRef, err)
	}
	return &template, nil
}

func (r *AnalysisRunReconciler) mergeArgs(templateArgs []pipelinesv1alpha1.AnalysisTemplateArg, runArgs map[string]string) map[string]string {
	out := map[string]string{}
	for _, a := range templateArgs {
		out[a.Name] = a.Default
	}
	for k, v := range runArgs {
		out[k] = v
	}
	return out
}

func (r *AnalysisRunReconciler) convertResults(results []analysis.Result) []pipelinesv1alpha1.AnalysisRunResult {
	out := make([]pipelinesv1alpha1.AnalysisRunResult, 0, len(results))
	now := metav1.Now()
	for i := range results {
		res := &results[i]
		out = append(out, pipelinesv1alpha1.AnalysisRunResult{
			Name:      res.Name,
			Passed:    res.Passed,
			Message:   res.Message,
			Detail:    res.Detail,
			CheckedAt: &now,
		})
	}
	return out
}

func (r *AnalysisRunReconciler) allPassed(results []analysis.Result) bool {
	for _, res := range results {
		if !res.Passed {
			return false
		}
	}
	return len(results) > 0
}

func (r *AnalysisRunReconciler) markRunError(ctx context.Context, run *pipelinesv1alpha1.AnalysisRun, reason, message string) error {
	run.Status.Phase = pipelinesv1alpha1.AnalysisRunError
	meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
	if err := r.client.Status().Update(ctx, run); err != nil {
		return fmt.Errorf("updating analysisrun error status: %w", err)
	}
	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AnalysisRunReconciler) SetupWithManager(mgr ctrl.Manager) error {
	r.client = mgr.GetClient()
	if err := ctrl.NewControllerManagedBy(mgr).
		For(&pipelinesv1alpha1.AnalysisRun{}).
		WithOptions(controller.Options{MaxConcurrentReconciles: 5}).
		Named("analysisrun").
		Complete(r); err != nil {
		return fmt.Errorf("setting up analysisrun controller: %w", err)
	}
	return nil
}
