package pipelines

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
)

type fakeConftestEvaluator struct {
	violations governance.Violations
	err        error
	calledRefs []paprikav1.ConftestPolicyRef
}

func (f *fakeConftestEvaluator) Evaluate(_ context.Context, _ string, refs []paprikav1.ConftestPolicyRef, _ []*unstructured.Unstructured) (governance.Violations, error) {
	f.calledRefs = refs
	return f.violations, f.err
}

// newReconcilerWithConftest builds a ReleaseReconciler backed by a fake client seeded with
// release. The fake client is required because runConftestGate's blocking path calls
// patchReleaseStatus, which does client.Get + Status().Update and panics on a nil client.
func newReconcilerWithConftest(t *testing.T, ev ConftestEvaluator, release *paprikav1.Release) *ReleaseReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(&paprikav1.Release{}).
		WithObjects(release).
		Build()
	r := NewReleaseReconciler(c)
	r.ConftestEvaluator = ev
	return r
}

// relForTest returns a Release with name/namespace set (required by patchReleaseStatus).
func relForTest() *paprikav1.Release {
	rel := &paprikav1.Release{}
	rel.SetName("test-release")
	rel.SetNamespace("default")
	rel.SetGeneration(1)
	return rel
}

func appWithPolicy(name string) *paprikav1.Application {
	return &paprikav1.Application{Spec: paprikav1.ApplicationSpec{ConftestPolicies: []paprikav1.ConftestPolicyRef{{Name: name}}}}
}

func conditionReason(rel *paprikav1.Release, wantReason string) bool {
	for _, c := range rel.Status.Conditions {
		if c.Type == conftestConditionType && c.Reason == wantReason {
			return true
		}
	}
	return false
}

func TestRunConftestGateDisabled(t *testing.T) {
	// nil evaluator: no-op, no condition, no patch (nil client is safe here).
	r := NewReleaseReconciler(nil)
	rel := relForTest()
	app := &paprikav1.Application{}
	require.NoError(t, r.runConftestGate(context.Background(), rel, app, nil))
	assert.Empty(t, rel.Status.Conditions)

	// evaluator set but no policies bound: also a no-op.
	r2 := newReconcilerWithConftest(t, &fakeConftestEvaluator{}, relForTest())
	require.NoError(t, r2.runConftestGate(context.Background(), relForTest(), &paprikav1.Application{}, nil))
}

func TestRunConftestGateBlocksOnEnforceViolation(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: "deny", Message: "no label", Action: governance.PolicyActionEnforce},
	}}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	err := r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil)
	require.Error(t, err)
	assert.True(t, conditionReason(rel, conftestReasonPolicyViolation), "expected PolicyViolation condition")
}

func TestRunConftestGateNotReadyWhenPolicyUncompilable(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: governance.SeverityNotReady, Message: "compile error", Action: governance.PolicyActionEnforce},
	}}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	err := r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil)
	require.Error(t, err)
	assert.True(t, conditionReason(rel, conftestReasonPolicyNotReady), "expected PolicyNotReady condition")
}

// TestRunConftestGateBlockWrapsSentinel pins that a blocking conftest gate returns an error
// matching errConftestBlocked via errors.Is, for both PolicyViolation and PolicyNotReady. The
// sentinel is what handlePromotingPhase recognizes to requeue without going terminal; the full
// non-terminal-requeue behavior is covered end-to-end by the Conftest e2e spec.
func TestRunConftestGateBlockWrapsSentinel(t *testing.T) {
	cases := []struct {
		name    string
		violate governance.Violation
		reason  string
	}{
		{
			name:    "policy violation wraps sentinel",
			violate: governance.Violation{Rule: "p", Severity: "deny", Message: "no label", Action: governance.PolicyActionEnforce},
			reason:  conftestReasonPolicyViolation,
		},
		{
			name:    "policy not-ready wraps sentinel",
			violate: governance.Violation{Rule: "p", Severity: governance.SeverityNotReady, Message: "missing", Action: governance.PolicyActionEnforce},
			reason:  conftestReasonPolicyNotReady,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev := &fakeConftestEvaluator{violations: governance.Violations{tc.violate}}
			rel := relForTest()
			r := newReconcilerWithConftest(t, ev, rel)
			err := r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil)
			require.Error(t, err)
			assert.True(t, errors.Is(err, errConftestBlocked),
				"blocking conftest error must match errConftestBlocked so handlePromotingPhase treats it as retryable")
			assert.True(t, conditionReason(rel, tc.reason), "expected %s condition", tc.reason)
		})
	}
}

func TestRunConftestGatePassesWithWarnings(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: "warn", Message: "soft", Action: governance.PolicyActionWarn},
	}}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	require.NoError(t, r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil))
	found := false
	for _, c := range rel.Status.Conditions {
		if c.Type == conftestConditionType && c.Reason == conftestReasonPassedWithWarnings && c.Status == "True" {
			found = true
		}
	}
	assert.True(t, found, "expected PassedWithWarnings=True")
}

func TestRunConftestGateEngineErrorSurfacesNoCondition(t *testing.T) {
	ev := &fakeConftestEvaluator{err: errors.New("boom")}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	err := r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil)
	require.Error(t, err)
	for _, c := range rel.Status.Conditions {
		assert.NotEqual(t, conftestConditionType, c.Type, "engine error must not set a conftest condition")
	}
}

func TestRunConftestGateDoesNotSpamEventsOnRepeatedBlock(t *testing.T) {
	rec := record.NewFakeRecorder(10)
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: "deny", Message: "no label", Action: governance.PolicyActionEnforce},
	}}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	r.EventRecorder = rec
	app := appWithPolicy("p")

	// A blocked release requeues and re-evaluates; the identical violation must produce
	// only one warning event across repeated reconciles.
	require.Error(t, r.runConftestGate(context.Background(), rel, app, nil))
	require.Error(t, r.runConftestGate(context.Background(), rel, app, nil))
	require.Error(t, r.runConftestGate(context.Background(), rel, app, nil))

	count := 0
loop:
	for {
		select {
		case <-rec.Events:
			count++
		default:
			break loop
		}
	}
	assert.Equal(t, 1, count, "expected exactly one warning event across identical repeated reconciles")
}

// fakeAllTemplatesRenderer is a minimal AllTemplatesRenderer used to drive promoteCanary's
// render step without a real template engine. It returns the configured manifests/error.
type fakeAllTemplatesRenderer struct {
	manifests []byte
	err       error
}

func (f *fakeAllTemplatesRenderer) RenderAll(_ context.Context, _ []paprikav1.Template, _ map[string]string) ([]byte, error) {
	return f.manifests, f.err
}

// buildCanaryPromotionReconciler wires a ReleaseReconciler just far enough for
// handleCanaryPromotion to reach runConftestGate: a Release owning an Application that binds
// a conftest policy, an empty-template Stage, a no-op governance gate (nil validators), and
// the supplied conftest evaluator and renderer.
func buildCanaryPromotionReconciler(t *testing.T, ev ConftestEvaluator, renderer AllTemplatesRenderer) (*ReleaseReconciler, *paprikav1.Release, *paprikav1.Stage) {
	t.Helper()
	app := &paprikav1.Application{}
	app.SetName("canary-app")
	app.SetNamespace("default")
	app.SetUID(types.UID("canary-app-uid"))
	app.Spec.ConftestPolicies = []paprikav1.ConftestPolicyRef{{Name: "p"}}

	release := relForTest()
	release.SetOwnerReferences([]metav1.OwnerReference{{
		APIVersion: paprikav1.GroupVersion.String(),
		Kind:       "Application",
		Name:       app.Name,
		UID:        app.UID,
	}})
	release.Status.Phase = paprikav1.ReleaseCanarying

	stage := &paprikav1.Stage{}
	stage.SetName("canary-stage")
	stage.Spec.Templates = nil // empty: fetchStageTemplates has nothing to fetch

	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(&paprikav1.Release{}).
		WithObjects(app, release).
		Build()

	r := NewReleaseReconciler(c)
	r.Scheme = scheme
	r.ConftestEvaluator = ev
	r.TemplateRenderer = renderer
	r.EventRecorder = record.NewFakeRecorder(10)
	return r, release, stage
}

// TestHandleCanaryPromotion_ConftestBlockStaysNonTerminal pins that a conftest gate block
// during canary promotion leaves the release non-terminal and requeues, mirroring the
// direct/rolling path (handlePromotingPhase). A non-sentinel promotion error still goes
// terminal Failed, confirming the sentinel branch is specific.
func TestHandleCanaryPromotion_ConftestBlockStaysNonTerminal(t *testing.T) {
	t.Run("conftest block requeues without going terminal", func(t *testing.T) {
		ev := &fakeConftestEvaluator{violations: governance.Violations{
			{Rule: "p", Severity: "deny", Message: "no label", Action: governance.PolicyActionEnforce},
		}}
		r, release, stage := buildCanaryPromotionReconciler(t, ev, &fakeAllTemplatesRenderer{})

		var result string
		res, err := r.handleCanaryPromotion(context.Background(), release, stage, &result)
		require.NoError(t, err, "a retryable conftest block must not surface as a reconcile error")
		assert.Equal(t, conftestBlockedRequeueInterval, res.RequeueAfter, "expected non-terminal requeue")
		assert.NotEqual(t, paprikav1.ReleaseFailed, release.Status.Phase,
			"conftest-blocked canary promotion must not go terminal")
		assert.True(t, conditionReason(release, conftestReasonPolicyViolation),
			"expected the gate to have recorded a PolicyViolation condition")
	})

	t.Run("non-sentinel promotion error still goes terminal", func(t *testing.T) {
		// A render error surfaces as a hard promotion failure (not errConftestBlocked), so the
		// release must still transition to Failed.
		renderErr := &fakeAllTemplatesRenderer{err: errors.New("render boom")}
		r, release, stage := buildCanaryPromotionReconciler(t, &fakeConftestEvaluator{}, renderErr)

		var result string
		res, err := r.handleCanaryPromotion(context.Background(), release, stage, &result)
		require.NoError(t, err)
		assert.Equal(t, time.Duration(0), res.RequeueAfter, "hard promotion failure must not requeue")
		assert.Equal(t, paprikav1.ReleaseFailed, release.Status.Phase,
			"non-sentinel promotion error must go terminal")
	})
}
