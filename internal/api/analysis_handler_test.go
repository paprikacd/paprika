package apiserver

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func newAnalysisRunTestClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	return fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(objs...).
		WithStatusSubresource(&pipelinesv1alpha1.AnalysisRun{}).
		Build()
}

func TestListAnalysisRuns_FiltersByNamespaceAndApplication(t *testing.T) {
	started := metav1.NewTime(time.Unix(1700000000, 0))
	completed := metav1.NewTime(time.Unix(1700000060, 0))
	cl := newAnalysisRunTestClient(t,
		&pipelinesv1alpha1.AnalysisRun{
			ObjectMeta: metav1.ObjectMeta{Name: "demo-analysis", Namespace: "apps", Labels: map[string]string{projectLabelKey: "default"}},
			Spec: pipelinesv1alpha1.AnalysisRunSpec{
				TemplateRef:    "latency-check",
				ApplicationRef: "demo-app",
				Args:           map[string]string{"service": "demo"},
			},
			Status: pipelinesv1alpha1.AnalysisRunStatus{
				ObservedGeneration: 2,
				Phase:              pipelinesv1alpha1.AnalysisRunFailed,
				CyclesExecuted:     3,
				StartedAt:          &started,
				CompletedAt:        &completed,
				Results: []pipelinesv1alpha1.AnalysisRunResult{
					{Name: "p99", Passed: false, Message: "latency too high", Detail: "p99=1200ms", CheckedAt: &completed},
				},
				Conditions: []metav1.Condition{
					{Type: "Complete", Status: metav1.ConditionFalse, Reason: "FailedChecks", Message: "1 check failed"},
				},
			},
		},
		&pipelinesv1alpha1.AnalysisRun{
			ObjectMeta: metav1.ObjectMeta{Name: "other-analysis", Namespace: "apps", Labels: map[string]string{projectLabelKey: "default"}},
			Spec:       pipelinesv1alpha1.AnalysisRunSpec{TemplateRef: "smoke", ApplicationRef: "other-app"},
		},
		&pipelinesv1alpha1.AnalysisRun{
			ObjectMeta: metav1.ObjectMeta{Name: "cross-ns", Namespace: "other", Labels: map[string]string{projectLabelKey: "default"}},
			Spec:       pipelinesv1alpha1.AnalysisRunSpec{TemplateRef: "smoke", ApplicationRef: "demo-app"},
		},
	)

	srv := NewPaprikaServer(cl, nil)
	resp, err := srv.ListAnalysisRuns(context.Background(), connect.NewRequest(&paprikav1.ListAnalysisRunsRequest{
		Namespace:       ptr("apps"),
		ApplicationName: "demo-app",
	}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.AnalysisRuns, 1)

	run := resp.Msg.AnalysisRuns[0]
	require.Equal(t, "demo-analysis", run.Name)
	require.Equal(t, "apps", run.Namespace)
	require.Equal(t, "latency-check", run.TemplateRef)
	require.Equal(t, "demo-app", run.ApplicationRef)
	require.Equal(t, "Failed", run.Phase)
	require.EqualValues(t, 3, run.CyclesExecuted)
	require.EqualValues(t, 1700000000, run.StartedAt)
	require.EqualValues(t, 1700000060, run.CompletedAt)
	require.EqualValues(t, 2, run.ObservedGeneration)
	require.Len(t, run.Results, 1)
	require.Equal(t, "p99", run.Results[0].Name)
	require.False(t, run.Results[0].Passed)
	require.Equal(t, "p99=1200ms", run.Results[0].Detail)
	require.Len(t, run.Conditions, 1)
	require.Equal(t, "Complete", run.Conditions[0].Type)
}

func TestGetAnalysisRun(t *testing.T) {
	cl := newAnalysisRunTestClient(t,
		&pipelinesv1alpha1.AnalysisRun{
			ObjectMeta: metav1.ObjectMeta{Name: "demo-analysis", Namespace: "apps", Labels: map[string]string{projectLabelKey: "default"}},
			Spec:       pipelinesv1alpha1.AnalysisRunSpec{TemplateRef: "smoke", ApplicationRef: "demo-app"},
			Status:     pipelinesv1alpha1.AnalysisRunStatus{Phase: pipelinesv1alpha1.AnalysisRunSuccessful},
		},
	)

	srv := NewPaprikaServer(cl, nil)
	resp, err := srv.GetAnalysisRun(context.Background(), connect.NewRequest(&paprikav1.GetAnalysisRunRequest{
		Namespace: "apps",
		Name:      "demo-analysis",
	}))
	require.NoError(t, err)
	require.Equal(t, "Successful", resp.Msg.AnalysisRun.Phase)
	require.Equal(t, "demo-app", resp.Msg.AnalysisRun.ApplicationRef)
}
