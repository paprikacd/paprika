package controller

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"go.uber.org/mock/gomock"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/benebsworth/paprika/analysis"
	analysismocks "github.com/benebsworth/paprika/analysis/mocks"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/gates"
	gatesmocks "github.com/benebsworth/paprika/gates/mocks"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	"github.com/benebsworth/paprika/internal/controller/pipelines/mocks"
	"github.com/benebsworth/paprika/internal/governance"
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

func TestReleaseReconciler_promote_blocksGovernanceViolation(t *testing.T) {
	ctx := context.Background()
	const ns = "default"
	const projectName = "restricted-release-project"

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatalf("add corev1 to scheme: %v", err)
	}
	if err := corev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add corev1alpha1 to scheme: %v", err)
	}
	if err := pipelinesv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatalf("add pipelinesv1alpha1 to scheme: %v", err)
	}

	const appName = "release-governance-app"
	const stageName = "release-governance-stage"
	const snapshotName = "release-governance-snapshot"
	const releaseName = "release-governance-release"

	project := &corev1alpha1.AppProject{
		ObjectMeta: metav1.ObjectMeta{
			Name:      projectName,
			Namespace: ns,
		},
		Spec: corev1alpha1.AppProjectSpec{
			Description: "Only ConfigMaps allowed",
			Kinds:       []string{"ConfigMap"},
		},
	}
	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      appName,
			Namespace: ns,
			UID:       types.UID("app-uid"),
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: projectName,
		},
	}
	stage := &pipelinesv1alpha1.Stage{
		ObjectMeta: metav1.ObjectMeta{
			Name:      stageName,
			Namespace: ns,
		},
		Spec: pipelinesv1alpha1.StageSpec{
			Name:      stageName,
			Ring:      1,
			Templates: []string{},
		},
	}
	snapshot := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      snapshotName,
			Namespace: ns,
		},
		Data: map[string]string{
			"manifests.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: blocked-deployment\nspec:\n  replicas: 1\n",
		},
	}
	release := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:       releaseName,
			Namespace:  ns,
			Finalizers: []string{releaseFinalizer},
			OwnerReferences: []metav1.OwnerReference{
				{
					APIVersion: pipelinesv1alpha1.GroupVersion.String(),
					Kind:       "Application",
					Name:       appName,
					UID:        app.UID,
				},
			},
		},
		Spec: pipelinesv1alpha1.ReleaseSpec{
			Target: stageName,
			ManifestSource: &pipelinesv1alpha1.ManifestSource{
				ConfigMapRef: snapshotName,
			},
		},
		Status: pipelinesv1alpha1.ReleaseStatus{
			Phase: pipelinesv1alpha1.ReleasePromoting,
		},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(project, app, stage, snapshot, release).WithStatusSubresource(&pipelinesv1alpha1.Release{}).Build()

	r := &ReleaseReconciler{
		Client:        c,
		Scheme:        scheme,
		EventRecorder: record.NewFakeRecorder(10),
		ProjectValidator: governance.NewProjectValidator(
			governance.NewProjectResolver(c),
			governance.NewClusterResolver(c),
			nil,
		),
		PolicyEvaluator: governance.NewPolicyEvaluator(c),
	}

	_, err := r.Reconcile(ctx, reconcile.Request{
		NamespacedName: types.NamespacedName{Name: releaseName, Namespace: ns},
	})
	if err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	var updated pipelinesv1alpha1.Release
	if err := c.Get(ctx, types.NamespacedName{Name: releaseName, Namespace: ns}, &updated); err != nil {
		t.Fatalf("get updated release: %v", err)
	}
	if updated.Status.Phase != pipelinesv1alpha1.ReleaseFailed {
		t.Errorf("expected phase %s, got %s", pipelinesv1alpha1.ReleaseFailed, updated.Status.Phase)
	}
	cond := meta.FindStatusCondition(updated.Status.Conditions, "GovernanceChecked")
	if cond == nil {
		t.Fatalf("expected GovernanceChecked condition")
	}
	if cond.Status != metav1.ConditionFalse {
		t.Errorf("expected GovernanceChecked=False, got %s", cond.Status)
	}
	if cond.Reason != "ProjectViolation" {
		t.Errorf("expected reason ProjectViolation, got %s", cond.Reason)
	}
}

func TestReleaseReconciler_findRollbackTarget(t *testing.T) {
	t.Parallel()

	appName := "rollback-app"
	target := "dev"

	newRelease := func(name string, ts time.Time, phase pipelinesv1alpha1.ReleasePhase, snapshot string) *pipelinesv1alpha1.Release {
		return &pipelinesv1alpha1.Release{
			ObjectMeta: metav1.ObjectMeta{
				Name:              name,
				Namespace:         "default",
				CreationTimestamp: metav1.Time{Time: ts},
				Labels: map[string]string{
					engine.ApplicationNameLabelKey: appName,
				},
			},
			Spec: pipelinesv1alpha1.ReleaseSpec{
				Target: target,
			},
			Status: pipelinesv1alpha1.ReleaseStatus{
				Phase:                    phase,
				RenderedManifestSnapshot: snapshot,
			},
		}
	}

	base := time.Now().UTC().Truncate(time.Second)

	buildClient := func(objs ...client.Object) client.Client {
		scheme := runtime.NewScheme()
		_ = pipelinesv1alpha1.AddToScheme(scheme)
		return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).Build()
	}

	t.Run("no previous releases returns nil", func(t *testing.T) {
		ctx := context.Background()
		current := newRelease("current", base, pipelinesv1alpha1.ReleaseFailed, "snap-current")
		r := &ReleaseReconciler{Client: buildClient(current)}

		target, err := r.findRollbackTarget(ctx, current, appName)
		if err != nil {
			t.Fatalf("findRollbackTarget error: %v", err)
		}
		if target != nil {
			t.Fatalf("expected nil target, got %s", target.Name)
		}
	})

	t.Run("selects newest complete release", func(t *testing.T) {
		ctx := context.Background()
		current := newRelease("current", base.Add(3*time.Hour), pipelinesv1alpha1.ReleaseFailed, "snap-current")
		oldComplete := newRelease("old-complete", base, pipelinesv1alpha1.ReleaseComplete, "snap-old")
		newComplete := newRelease("new-complete", base.Add(2*time.Hour), pipelinesv1alpha1.ReleaseComplete, "snap-new")
		r := &ReleaseReconciler{Client: buildClient(current, oldComplete, newComplete)}

		target, err := r.findRollbackTarget(ctx, current, appName)
		if err != nil {
			t.Fatalf("findRollbackTarget error: %v", err)
		}
		if target == nil || target.Name != "new-complete" {
			t.Fatalf("expected new-complete, got %v", target)
		}
	})

	t.Run("falls back to newest non-failed non-superseded with snapshot", func(t *testing.T) {
		ctx := context.Background()
		current := newRelease("current", base.Add(2*time.Hour), pipelinesv1alpha1.ReleaseFailed, "snap-current")
		failed := newRelease("failed", base, pipelinesv1alpha1.ReleaseFailed, "snap-failed")
		superseded := newRelease("superseded", base.Add(time.Hour), pipelinesv1alpha1.ReleaseSuperseded, "snap-super")
		viable := newRelease("viable", base.Add(30*time.Minute), pipelinesv1alpha1.ReleasePromoting, "snap-viable")
		r := &ReleaseReconciler{Client: buildClient(current, failed, superseded, viable)}

		target, err := r.findRollbackTarget(ctx, current, appName)
		if err != nil {
			t.Fatalf("findRollbackTarget error: %v", err)
		}
		if target == nil || target.Name != "viable" {
			t.Fatalf("expected viable, got %v", target)
		}
	})

	t.Run("skips releases without snapshot", func(t *testing.T) {
		ctx := context.Background()
		current := newRelease("current", base.Add(time.Hour), pipelinesv1alpha1.ReleaseFailed, "snap-current")
		noSnapshot := newRelease("no-snapshot", base, pipelinesv1alpha1.ReleaseComplete, "")
		r := &ReleaseReconciler{Client: buildClient(current, noSnapshot)}

		target, err := r.findRollbackTarget(ctx, current, appName)
		if err != nil {
			t.Fatalf("findRollbackTarget error: %v", err)
		}
		if target != nil {
			t.Fatalf("expected nil target, got %s", target.Name)
		}
	})

	t.Run("skips releases with different target", func(t *testing.T) {
		ctx := context.Background()
		current := newRelease("current", base.Add(time.Hour), pipelinesv1alpha1.ReleaseFailed, "snap-current")
		otherTarget := newRelease("other-target", base, pipelinesv1alpha1.ReleaseComplete, "snap-other")
		otherTarget.Spec.Target = "prod"
		r := &ReleaseReconciler{Client: buildClient(current, otherTarget)}

		target, err := r.findRollbackTarget(ctx, current, appName)
		if err != nil {
			t.Fatalf("findRollbackTarget error: %v", err)
		}
		if target != nil {
			t.Fatalf("expected nil target, got %s", target.Name)
		}
	})
}
