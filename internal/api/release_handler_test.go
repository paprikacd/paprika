package apiserver

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
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
