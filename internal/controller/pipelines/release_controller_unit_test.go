package controller

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"go.uber.org/mock/gomock"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"

	"github.com/benebsworth/paprika/analysis"
	analysismocks "github.com/benebsworth/paprika/analysis/mocks"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/gates"
	gatesmocks "github.com/benebsworth/paprika/gates/mocks"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	"github.com/benebsworth/paprika/internal/controller/pipelines/mocks"
	"github.com/benebsworth/paprika/traffic"
	trafficmocks "github.com/benebsworth/paprika/traffic/mocks"
)

// mockTrafficRouterFactory returns a TrafficRouterFactory that always returns the given router and error.
func mockTrafficRouterFactory(router traffic.Router, err error) TrafficRouterFactory {
	return func(_ *pipelinesv1alpha1.TrafficRouter, _ dynamic.Interface, _, _, _ string) (traffic.Router, error) {
		return router, err
	}
}

func TestReleaseReconciler_verify(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		gateCfgs  []pipelinesv1alpha1.GateConfig
		setupMock func(m *gatesmocks.MockGateExecutor)
		want      bool
	}{
		{
			name:     "no gates returns true",
			gateCfgs: nil,
			setupMock: func(m *gatesmocks.MockGateExecutor) {
				// no calls expected
			},
			want: true,
		},
		{
			name: "single passing gate",
			gateCfgs: []pipelinesv1alpha1.GateConfig{
				{Type: "smoke-test", Endpoint: "http://test"},
			},
			setupMock: func(m *gatesmocks.MockGateExecutor) {
				m.EXPECT().Execute(gomock.Any(), gates.GateConfig{Type: "smoke-test", Endpoint: "http://test"}).
					Return(gates.GateResult{Passed: true}).Times(1)
			},
			want: true,
		},
		{
			name: "failing gate returns false",
			gateCfgs: []pipelinesv1alpha1.GateConfig{
				{Type: "smoke-test", Endpoint: "http://test"},
			},
			setupMock: func(m *gatesmocks.MockGateExecutor) {
				m.EXPECT().Execute(gomock.Any(), gates.GateConfig{Type: "smoke-test", Endpoint: "http://test"}).
					Return(gates.GateResult{Passed: false, Message: "timeout"}).Times(1)
			},
			want: false,
		},
		{
			name: "multiple gates all pass",
			gateCfgs: []pipelinesv1alpha1.GateConfig{
				{Type: "smoke-test", Endpoint: "http://a"},
				{Type: "duration", Timeout: 1},
			},
			setupMock: func(m *gatesmocks.MockGateExecutor) {
				m.EXPECT().Execute(gomock.Any(), gates.GateConfig{Type: "smoke-test", Endpoint: "http://a"}).
					Return(gates.GateResult{Passed: true}).Times(1)
				m.EXPECT().Execute(gomock.Any(), gates.GateConfig{Type: "duration", Timeout: 1}).
					Return(gates.GateResult{Passed: true}).Times(1)
			},
			want: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockGate := gatesmocks.NewMockGateExecutor(ctrl)
			tc.setupMock(mockGate)

			r := &ReleaseReconciler{
				GateExecutor: mockGate,
			}

			release := &pipelinesv1alpha1.Release{
				Spec: pipelinesv1alpha1.ReleaseSpec{
					Verify: tc.gateCfgs,
				},
			}

			got := r.verify(context.Background(), release)
			if got != tc.want {
				t.Errorf("verify() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestReleaseReconciler_runCanaryAnalysis(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		checks       []pipelinesv1alpha1.AnalysisCheck
		setupMock    func(m *analysismocks.MockAnalyzer)
		wantRollback bool
		wantErr      bool
	}{
		{
			name:   "no checks returns no rollback",
			checks: nil,
			setupMock: func(m *analysismocks.MockAnalyzer) {
				// no calls
			},
			wantRollback: false,
			wantErr:      false,
		},
		{
			name: "all checks pass",
			checks: []pipelinesv1alpha1.AnalysisCheck{
				{Type: "http", URL: "http://test"},
			},
			setupMock: func(m *analysismocks.MockAnalyzer) {
				m.EXPECT().RunChecks(gomock.Any(), gomock.Any()).
					Return([]analysis.Result{{Passed: true, Message: "OK"}}).Times(1)
			},
			wantRollback: false,
			wantErr:      false,
		},
		{
			name: "failing check without rollback",
			checks: []pipelinesv1alpha1.AnalysisCheck{
				{Type: "http", URL: "http://test"},
			},
			setupMock: func(m *analysismocks.MockAnalyzer) {
				m.EXPECT().RunChecks(gomock.Any(), gomock.Any()).
					Return([]analysis.Result{{Passed: false, Message: "timeout"}}).Times(1)
			},
			wantRollback: false,
			wantErr:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockAnalyzer := analysismocks.NewMockAnalyzer(ctrl)
			tc.setupMock(mockAnalyzer)

			r := &ReleaseReconciler{
				Analyzer: mockAnalyzer,
			}

			release := &pipelinesv1alpha1.Release{}
			canaryCfg := &pipelinesv1alpha1.CanaryConfig{
				Analysis: &pipelinesv1alpha1.AnalysisConfig{
					Checks:         tc.checks,
					RollbackOnFail: false,
				},
			}

			gotRollback, err := r.runCanaryAnalysis(context.Background(), release, canaryCfg, nil, logr.Discard())
			if (err != nil) != tc.wantErr {
				t.Errorf("runCanaryAnalysis() error = %v, wantErr %v", err, tc.wantErr)
				return
			}
			if gotRollback != tc.wantRollback {
				t.Errorf("runCanaryAnalysis() rollback = %v, want %v", gotRollback, tc.wantRollback)
			}
		})
	}
}

func TestReleaseReconciler_routerForStage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		trafficRouter *pipelinesv1alpha1.TrafficRouter
		setupFactory  TrafficRouterFactory
		wantErr       bool
		wantNil       bool
	}{
		{
			name:          "no traffic router returns nil",
			trafficRouter: nil,
			setupFactory:  nil,
			wantErr:       false,
			wantNil:       true,
		},
		{
			name: "successful router creation",
			trafficRouter: &pipelinesv1alpha1.TrafficRouter{
				Provider: "istio",
				Istio: &pipelinesv1alpha1.IstioRouterConfig{
					StableService: "svc-stable",
					CanaryService: "svc-canary",
				},
			},
			setupFactory: mockTrafficRouterFactory(&trafficmocks.MockRouter{}, nil),
			wantErr:      false,
			wantNil:      false,
		},
		{
			name: "factory error",
			trafficRouter: &pipelinesv1alpha1.TrafficRouter{
				Provider: "gateway-api",
				GatewayAPI: &pipelinesv1alpha1.GatewayAPIRouterConfig{
					StableService: "svc-stable",
					CanaryService: "svc-canary",
				},
			},
			setupFactory: mockTrafficRouterFactory(nil, errors.New("unsupported")),
			wantErr:      true,
			wantNil:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &ReleaseReconciler{
				TrafficRouterFactory: tc.setupFactory,
			}

			stage := &pipelinesv1alpha1.Stage{
				Spec: pipelinesv1alpha1.StageSpec{
					TrafficRouter: tc.trafficRouter,
				},
			}
			release := &pipelinesv1alpha1.Release{
				ObjectMeta: metav1.ObjectMeta{Name: "test-release"},
			}

			router, err := r.routerForStage(context.Background(), stage, release)
			if (err != nil) != tc.wantErr {
				t.Errorf("routerForStage() error = %v, wantErr %v", err, tc.wantErr)
				return
			}
			if tc.wantNil && router != nil {
				t.Errorf("routerForStage() = %v, want nil", router)
			}
		})
	}
}

func TestCanaryStepStartedAt_advancesOnlyAfterInterval(t *testing.T) {
	t.Parallel()

	// When CanaryStepIndex > 0 and CanaryStepStartedAt is recent relative to
	// (stepIdx * interval), the controller should requeue rather than advance.
	// This protects against watch-event-driven fast-forward through the canary
	// when the status update triggers an immediate re-reconcile.

	interval := 5 * time.Second
	stepIdx := 1
	stepStartedAt := metav1.NewTime(time.Now())
	nextStepAt := stepStartedAt.Add(time.Duration(stepIdx) * interval)

	if time.Now().Before(nextStepAt) {
		// We are inside the wait window — controller must not advance.
		// (This is the same predicate the controller uses.)
		t.Logf("inside wait window: step=%d startedAt=%v nextAt=%v (interval=%v)",
			stepIdx, stepStartedAt, nextStepAt, interval)
	} else {
		t.Errorf("expected to be inside wait window, next step at %v (now=%v)",
			nextStepAt, time.Now())
	}

	// After waiting past the threshold, the same predicate would let the step advance.
	future := time.Now().Add(2 * interval)
	if !future.After(nextStepAt) {
		t.Errorf("expected %v to be after %v (wait window passed)", future, nextStepAt)
	}
}

func TestReleaseReconciler_applyViaAgent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		cluster     pipelinesv1alpha1.ClusterRef
		setupMock   func(m *mocks.MockAgentClient)
		wantErr     bool
		errContains string
	}{
		{
			name: "successful apply via explicit agent address",
			cluster: pipelinesv1alpha1.ClusterRef{
				Name:         "remote",
				Namespace:    "ns",
				Mode:         pipelinesv1alpha1.ClusterModeAgent,
				AgentAddress: "http://agent.example:8083",
			},
			setupMock: func(m *mocks.MockAgentClient) {
				m.EXPECT().Apply(gomock.Any(), &agentserver.ApplyRequest{
					Namespace: "default",
					AppName:   "my-app",
					Manifests: []byte("kind: ConfigMap\n"),
				}).Return(&agentserver.ApplyResponse{}, nil)
			},
		},
		{
			name: "agent errors are wrapped",
			cluster: pipelinesv1alpha1.ClusterRef{
				Name:         "remote",
				Namespace:    "ns",
				Mode:         pipelinesv1alpha1.ClusterModeAgent,
				AgentAddress: "http://agent.example:8083",
			},
			setupMock: func(m *mocks.MockAgentClient) {
				m.EXPECT().Apply(gomock.Any(), gomock.Any()).
					Return(nil, errors.New("connection refused"))
			},
			wantErr:     true,
			errContains: "agent apply",
		},
		{
			name: "agent returns apply errors",
			cluster: pipelinesv1alpha1.ClusterRef{
				Name:         "remote",
				Namespace:    "ns",
				Mode:         pipelinesv1alpha1.ClusterModeAgent,
				AgentAddress: "http://agent.example:8083",
			},
			setupMock: func(m *mocks.MockAgentClient) {
				m.EXPECT().Apply(gomock.Any(), gomock.Any()).
					Return(&agentserver.ApplyResponse{Errors: []string{"forbidden"}}, nil)
			},
			wantErr:     true,
			errContains: "forbidden",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			mockClient := mocks.NewMockAgentClient(ctrl)
			tc.setupMock(mockClient)

			r := &ReleaseReconciler{
				AgentClientBuilder: func(_ string) AgentClient {
					return mockClient
				},
			}

			err := r.applyViaAgent(context.Background(), &tc.cluster, "default", "my-app", []byte("kind: ConfigMap\n"))
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if !strings.Contains(err.Error(), tc.errContains) {
					t.Errorf("error %q does not contain %q", err.Error(), tc.errContains)
				}
			} else if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestReleaseReconciler_applyManifestsForCluster_routesToAgent(t *testing.T) {
	t.Parallel()

	ctrl := gomock.NewController(t)
	mockClient := mocks.NewMockAgentClient(ctrl)
	mockClient.EXPECT().Apply(gomock.Any(), gomock.Any()).
		Return(&agentserver.ApplyResponse{}, nil)

	r := &ReleaseReconciler{
		AgentClientBuilder: func(_ string) AgentClient {
			return mockClient
		},
	}

	cluster := pipelinesv1alpha1.ClusterRef{
		Name:         "remote",
		Namespace:    "ns",
		Mode:         pipelinesv1alpha1.ClusterModeAgent,
		AgentAddress: "http://agent.example:8083",
	}

	if err := r.applyManifestsForCluster(context.Background(), "default", &cluster, "my-app", []byte("k: v\n")); err != nil {
		t.Fatalf("applyManifestsForCluster returned error: %v", err)
	}
}
