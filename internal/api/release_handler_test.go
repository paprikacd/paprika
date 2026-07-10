package apiserver

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/engine"
)

func TestConvertRelease_ExposesRolloutHooksConditionsAndCanaryState(t *testing.T) {
	started := metav1.NewTime(time.Unix(1700000010, 0))
	completed := metav1.NewTime(time.Unix(1700000020, 0))
	stepStarted := metav1.NewTime(time.Unix(1700000030, 0))
	promoted := metav1.NewTime(time.Unix(1700000040, 0))

	rel := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "demo-release", Namespace: "apps", Labels: map[string]string{"app.kubernetes.io/name": "demo-app"}},
		Spec:       pipelinesv1alpha1.ReleaseSpec{Pipeline: "demo-pipeline", Target: "prod"},
		Status: pipelinesv1alpha1.ReleaseStatus{
			ObservedGeneration:       7,
			Phase:                    pipelinesv1alpha1.ReleaseCanarying,
			CurrentStage:             "prod",
			RenderedManifestSnapshot: "demo-release-snapshot",
			CanaryWeight:             50,
			CanaryStepIndex:          2,
			CanaryStepStartedAt:      &stepStarted,
			RolloutRef:               "demo-rollout",
			Conditions: []metav1.Condition{
				{Type: "PolicyReady", Status: metav1.ConditionTrue, Reason: "Passed", Message: "policies passed"},
			},
			PromotionHistory: []pipelinesv1alpha1.PromotionEntry{
				{Stage: "prod", Result: "Promoted", ManifestSnapshot: "prod-snapshot", Timestamp: promoted},
			},
			HookStatuses: []pipelinesv1alpha1.HookStatus{
				{
					Kind:        "Job",
					Name:        "pre-sync",
					Namespace:   "apps",
					Phase:       "PreSync",
					Status:      "Succeeded",
					StartedAt:   &started,
					CompletedAt: &completed,
					Message:     "completed",
				},
			},
		},
	}

	got := convertRelease(rel)
	require.EqualValues(t, 7, got.ObservedGeneration)
	require.Equal(t, "demo-release-snapshot", got.RenderedManifestSnapshot)
	require.EqualValues(t, 50, got.CanaryWeight)
	require.EqualValues(t, 2, got.CanaryStepIndex)
	require.EqualValues(t, 1700000030, got.CanaryStepStartedAt)
	require.Equal(t, "demo-rollout", got.RolloutRef)
	require.Len(t, got.Conditions, 1)
	require.Equal(t, "PolicyReady", got.Conditions[0].Type)
	require.Len(t, got.PromotionHistory, 1)
	require.Equal(t, "prod-snapshot", got.PromotionHistory[0].ManifestSnapshot)
	require.Len(t, got.HookStatuses, 1)
	require.Equal(t, "PreSync", got.HookStatuses[0].Phase)
	require.Equal(t, "Succeeded", got.HookStatuses[0].Status)
	require.EqualValues(t, 1700000010, got.HookStatuses[0].StartedAt)
	require.EqualValues(t, 1700000020, got.HookStatuses[0].CompletedAt)
}

func TestListReleases_FiltersByApplicationAndPaginatesNewestFirst(t *testing.T) {
	release := func(name, app string, created int64) *pipelinesv1alpha1.Release {
		return &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{
				Name:              name,
				Namespace:         "apps",
				CreationTimestamp: metav1.NewTime(time.Unix(created, 0)),
				Labels: map[string]string{
					projectLabelKey:                "default",
					engine.ApplicationNameLabelKey: app,
				},
			},
			Spec: pipelinesv1alpha1.ReleaseSpec{Pipeline: "deploy", Target: "prod"},
		}
	}
	cl := newPipelineTestClient(
		release("checkout-1", "checkout", 100),
		release("checkout-2", "checkout", 300),
		release("checkout-3", "checkout", 200),
		release("billing-1", "billing", 400),
	)
	srv := NewPaprikaServer(cl, nil)
	namespace := "apps"

	resp, err := srv.ListReleases(context.Background(), connect.NewRequest(&paprikav1.ListReleasesRequest{
		Namespace:       &namespace,
		ApplicationName: "checkout",
		PageSize:        2,
		PageOffset:      1,
	}))

	require.NoError(t, err)
	require.EqualValues(t, 3, resp.Msg.TotalCount)
	require.Len(t, resp.Msg.Releases, 2)
	require.Equal(t, "checkout-3", resp.Msg.Releases[0].Name)
	require.Equal(t, "checkout-1", resp.Msg.Releases[1].Name)
}
