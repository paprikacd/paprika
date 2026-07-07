package apiserver

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

func TestConvertRollout_ExposesStrategyTrafficAndDebugState(t *testing.T) {
	replicas := int32(4)
	failedThreshold := int32(1)
	currentStarted := metav1.NewTime(time.Unix(1700000010, 0))
	promotedAt := metav1.NewTime(time.Unix(1700000100, 0))
	previewHealthyAt := metav1.NewTime(time.Unix(1700000060, 0))
	autoPromotion := int32(120)
	scaleDownDelay := int32(60)

	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "checkout", Namespace: "apps"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Target:   rolloutsv1alpha1.RolloutTarget{Kind: "Deployment", Name: "checkout"},
			Replicas: &replicas,
			Paused:   true,
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type: "Canary",
				Canary: &rolloutsv1alpha1.CanaryStrategy{
					StableService: "checkout-stable",
					CanaryService: "checkout-canary",
					Steps: []rolloutsv1alpha1.CanaryStep{
						{SetWeight: 10, Duration: &metav1.Duration{Duration: 2 * time.Minute}},
						{SetWeight: 50},
					},
					Analysis: &rolloutsv1alpha1.RolloutAnalysis{
						FailedThreshold: &failedThreshold,
						Checks: []rolloutsv1alpha1.AnalysisCheck{
							{Type: "http", URL: "https://checkout.example.com/health", SuccessThreshold: "99%"},
						},
					},
				},
				BlueGreen: &rolloutsv1alpha1.BlueGreenStrategy{
					ActiveService:         "checkout-active",
					PreviewService:        "checkout-preview",
					AutoPromotionSeconds:  &autoPromotion,
					ScaleDownDelaySeconds: &scaleDownDelay,
				},
				ABTest: &rolloutsv1alpha1.ABTestStrategy{
					Routes: []rolloutsv1alpha1.ABTestRoute{
						{Type: "Header", Name: "x-user-ring", Value: "beta", Service: "canary"},
					},
				},
				Mirror: &rolloutsv1alpha1.MirrorStrategy{MirrorPercent: 15},
			},
			TrafficRouter: &rolloutsv1alpha1.TrafficRouter{
				Provider: "gateway-api",
				GatewayAPI: &rolloutsv1alpha1.GatewayAPIRouterConfig{
					HTTPRoute:     "checkout-route",
					StableService: "checkout-stable",
					CanaryService: "checkout-canary",
				},
			},
		},
		Status: rolloutsv1alpha1.RolloutStatus{
			Phase:                rolloutsv1alpha1.RolloutPhasePaused,
			CurrentStepIndex:     1,
			CurrentStepWeight:    50,
			CurrentStepStartedAt: &currentStarted,
			StableRS:             "checkout-7bd",
			CanaryRS:             "checkout-95f",
			StableReadyReplicas:  4,
			CanaryReadyReplicas:  2,
			PromotedAt:           &promotedAt,
			PreviewHealthyAt:     &previewHealthyAt,
			Abort:                true,
			CurrentPodHash:       "95f",
			PreviousActiveRS:     "checkout-66c",
		},
	}

	got := convertRollout(ro)
	require.EqualValues(t, 4, got.Replicas)
	require.True(t, got.Paused)
	require.True(t, got.Abort)
	require.EqualValues(t, 4, got.StableReadyReplicas)
	require.EqualValues(t, 2, got.CanaryReadyReplicas)
	require.EqualValues(t, 1700000010, got.CurrentStepStartedAt)
	require.EqualValues(t, 1700000100, got.PromotedAt)
	require.EqualValues(t, 1700000060, got.PreviewHealthyAt)
	require.Equal(t, "95f", got.CurrentPodHash)
	require.Equal(t, "checkout-66c", got.PreviousActiveRs)
	require.Equal(t, "gateway-api", got.TrafficRouter.Provider)
	require.Equal(t, "checkout-route", got.TrafficRouter.GatewayApi.HttpRoute)
	require.Len(t, got.CanarySteps, 2)
	require.EqualValues(t, 10, got.CanarySteps[0].SetWeight)
	require.Equal(t, "2m0s", got.CanarySteps[0].Duration)
	require.Len(t, got.AnalysisChecks, 1)
	require.Equal(t, "http", got.AnalysisChecks[0].Type)
	require.Len(t, got.AbRoutes, 1)
	require.Equal(t, "x-user-ring", got.AbRoutes[0].Name)
	require.EqualValues(t, 15, got.MirrorPercent)
	require.EqualValues(t, 120, got.AutoPromotionSeconds)
	require.EqualValues(t, 60, got.ScaleDownDelaySeconds)
}
