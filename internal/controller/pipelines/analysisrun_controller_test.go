package controller

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/analysis"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

type fakeAnalyzer struct {
	results []analysis.Result
}

func (f *fakeAnalyzer) RunChecks(_ context.Context, _ []pipelinesv1alpha1.AnalysisCheck) []analysis.Result {
	return f.results
}

func newAnalysisRunTestClient(objs ...client.Object) client.Client {
	scheme := runtime.NewScheme()
	_ = pipelinesv1alpha1.AddToScheme(scheme)
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).WithStatusSubresource(&pipelinesv1alpha1.AnalysisRun{}).Build()
}

func TestAnalysisRunReconciler_reconcileRun_pendingToSuccessful(t *testing.T) {
	ctx := context.Background()
	template := &pipelinesv1alpha1.AnalysisTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "tpl", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisTemplateSpec{
			Checks: []pipelinesv1alpha1.AnalysisCheck{{Type: "http", URL: "http://test"}},
		},
	}
	run := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{Name: "app-tpl-analysis", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:    "tpl",
			ApplicationRef: "app",
		},
	}
	r := &AnalysisRunReconciler{
		Client:   newAnalysisRunTestClient(template, run),
		Analyzer: &fakeAnalyzer{results: []analysis.Result{{Name: "check", Passed: true}}},
	}

	if err := r.reconcileRun(ctx, run); err != nil {
		t.Fatalf("reconcileRun failed: %v", err)
	}
	if run.Status.Phase != pipelinesv1alpha1.AnalysisRunSuccessful {
		t.Errorf("phase: got %q, want %q", run.Status.Phase, pipelinesv1alpha1.AnalysisRunSuccessful)
	}
	if run.Status.CyclesExecuted != 1 {
		t.Errorf("cycles: got %d, want 1", run.Status.CyclesExecuted)
	}
}

func TestAnalysisRunReconciler_reconcileRun_missingTemplate(t *testing.T) {
	ctx := context.Background()
	run := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{Name: "app-tpl-analysis", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:    "missing",
			ApplicationRef: "app",
		},
	}
	r := &AnalysisRunReconciler{
		Client:   newAnalysisRunTestClient(run),
		Analyzer: &fakeAnalyzer{},
	}

	if err := r.reconcileRun(ctx, run); err != nil {
		t.Fatalf("reconcileRun failed: %v", err)
	}
	if run.Status.Phase != pipelinesv1alpha1.AnalysisRunError {
		t.Errorf("phase: got %q, want %q", run.Status.Phase, pipelinesv1alpha1.AnalysisRunError)
	}
}

func TestAnalysisRunReconciler_reconcileRun_countTermination(t *testing.T) {
	ctx := context.Background()
	template := &pipelinesv1alpha1.AnalysisTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "tpl", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisTemplateSpec{
			Checks: []pipelinesv1alpha1.AnalysisCheck{{Type: "http", URL: "http://test"}},
		},
	}
	run := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{Name: "app-tpl-analysis", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef: "tpl",
			Count:       1,
		},
	}
	r := &AnalysisRunReconciler{
		Client:   newAnalysisRunTestClient(template, run),
		Analyzer: &fakeAnalyzer{results: []analysis.Result{{Passed: true}}},
	}

	if err := r.reconcileRun(ctx, run); err != nil {
		t.Fatalf("reconcileRun failed: %v", err)
	}
	if run.Status.Phase != pipelinesv1alpha1.AnalysisRunCompleted {
		t.Errorf("phase: got %q, want %q", run.Status.Phase, pipelinesv1alpha1.AnalysisRunCompleted)
	}
	if run.Status.CompletedAt == nil {
		t.Error("expected CompletedAt to be set")
	}
}

func TestAnalysisRunReconciler_reconcileRun_terminateOnFailure(t *testing.T) {
	ctx := context.Background()
	template := &pipelinesv1alpha1.AnalysisTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "tpl", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisTemplateSpec{
			Checks: []pipelinesv1alpha1.AnalysisCheck{{Type: "http", URL: "http://test"}},
		},
	}
	run := &pipelinesv1alpha1.AnalysisRun{
		ObjectMeta: metav1.ObjectMeta{Name: "app-tpl-analysis", Namespace: "default"},
		Spec: pipelinesv1alpha1.AnalysisRunSpec{
			TemplateRef:        "tpl",
			TerminateOnFailure: true,
		},
	}
	r := &AnalysisRunReconciler{
		Client:   newAnalysisRunTestClient(template, run),
		Analyzer: &fakeAnalyzer{results: []analysis.Result{{Passed: false}}},
	}

	if err := r.reconcileRun(ctx, run); err != nil {
		t.Fatalf("reconcileRun failed: %v", err)
	}
	if run.Status.Phase != pipelinesv1alpha1.AnalysisRunFailed {
		t.Errorf("phase: got %q, want %q", run.Status.Phase, pipelinesv1alpha1.AnalysisRunFailed)
	}
	if run.Status.CompletedAt == nil {
		t.Error("expected CompletedAt to be set")
	}
}

func TestAnalysisRunReconciler_mergeArgs(t *testing.T) {
	r := &AnalysisRunReconciler{}
	templateArgs := []pipelinesv1alpha1.AnalysisTemplateArg{
		{Name: "a", Default: "default-a"},
		{Name: "b", Default: "default-b"},
	}
	runArgs := map[string]string{"b": "run-b"}
	got := r.mergeArgs(templateArgs, runArgs)
	if got["a"] != "default-a" || got["b"] != "run-b" {
		t.Errorf("unexpected args: %v", got)
	}
}
