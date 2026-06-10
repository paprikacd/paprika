package health_test

import (
	"context"
	"testing"

	"go.uber.org/mock/gomock"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/health"
	healthmocks "github.com/benebsworth/paprika/health/mocks"
)

func TestHealthEvaluatorWithMocks(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		setupMock      func(m *healthmocks.MockHealthEvaluator)
		app            *paprikav1.Application
		expectedResult func() health.EvalResult
	}{
		{
			name: "healthy check returns Healthy status",
			setupMock: func(m *healthmocks.MockHealthEvaluator) {
				m.EXPECT().Evaluate(gomock.Any(), gomock.Any(), gomock.Any()).
					Return(health.EvalResult{
						Name:   "test-check",
						Status: paprikav1.HealthHealthy,
					}).Times(1)
			},
			app: &paprikav1.Application{},
			expectedResult: func() health.EvalResult {
				return health.EvalResult{
					Name:   "test-check",
					Status: paprikav1.HealthHealthy,
				}
			},
		},
		{
			name: "degraded check returns Degraded status",
			setupMock: func(m *healthmocks.MockHealthEvaluator) {
				m.EXPECT().Evaluate(gomock.Any(), gomock.Any(), gomock.Any()).
					Return(health.EvalResult{
						Name:   "failed-check",
						Status: paprikav1.HealthDegraded,
					}).Times(1)
			},
			app: &paprikav1.Application{},
			expectedResult: func() health.EvalResult {
				return health.EvalResult{
					Name:   "failed-check",
					Status: paprikav1.HealthDegraded,
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockEvaluator := healthmocks.NewMockHealthEvaluator(ctrl)
			tc.setupMock(mockEvaluator)

			check := paprikav1.HealthCheck{Name: tc.name}
			result := mockEvaluator.Evaluate(context.Background(), check, tc.app)
			expected := tc.expectedResult()

			if result.Status != expected.Status {
				t.Errorf("expected status %s, got %s", expected.Status, result.Status)
			}
		})
	}
}

func TestResourceHealthCheckerWithMocks(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		kind           string
		setupMock      func(m *healthmocks.MockResourceHealthChecker)
		expectedHealth paprikav1.HealthStatus
	}{
		{
			name: "deployment healthy",
			kind: "Deployment",
			setupMock: func(m *healthmocks.MockResourceHealthChecker) {
				m.EXPECT().Check(gomock.Any(), "Deployment", "test-deploy", "default").
					Return(paprikav1.ResourceHealth{
						Kind:      "Deployment",
						Name:      "test-deploy",
						Namespace: "default",
						Health:    "Healthy",
						Message:   "3/3 replicas ready",
					}).Times(1)
			},
			expectedHealth: paprikav1.HealthHealthy,
		},
		{
			name: "service healthy",
			kind: "Service",
			setupMock: func(m *healthmocks.MockResourceHealthChecker) {
				m.EXPECT().Check(gomock.Any(), "Service", "test-svc", "default").
					Return(paprikav1.ResourceHealth{
						Kind:      "Service",
						Name:      "test-svc",
						Namespace: "default",
						Health:    "Healthy",
					}).Times(1)
			},
			expectedHealth: paprikav1.HealthHealthy,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockChecker := healthmocks.NewMockResourceHealthChecker(ctrl)
			tc.setupMock(mockChecker)

			var name string
			switch tc.kind {
			case "Deployment":
				name = "test-deploy"
			case "Service":
				name = "test-svc"
			default:
				name = "test-resource"
			}

			result := mockChecker.Check(context.Background(), tc.kind, name, "default")
			if paprikav1.HealthStatus(result.Health) != tc.expectedHealth {
				t.Errorf("expected health %s, got %s", tc.expectedHealth, result.Health)
			}
		})
	}
}
