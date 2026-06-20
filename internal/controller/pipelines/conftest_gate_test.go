package pipelines

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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
		{Rule: "p", Severity: conftestSeverityNotReady, Message: "compile error", Action: governance.PolicyActionEnforce},
	}}
	rel := relForTest()
	r := newReconcilerWithConftest(t, ev, rel)
	err := r.runConftestGate(context.Background(), rel, appWithPolicy("p"), nil)
	require.Error(t, err)
	assert.True(t, conditionReason(rel, conftestReasonPolicyNotReady), "expected PolicyNotReady condition")
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
