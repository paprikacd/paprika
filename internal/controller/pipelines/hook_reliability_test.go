package pipelines

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/clock"
	"github.com/benebsworth/paprika/internal/engine/hooks"
)

func TestBeforeHookCreationPolicy(t *testing.T) {
	for _, value := range []string{"", "  ", "BeforeHookCreation", "BeforeHookCreation,HookSucceeded", "HookSucceeded, BeforeHookCreation "} {
		require.True(t, beforeHookCreation(value), value)
	}
	for _, value := range []string{"HookSucceeded", "HookFailed", "NotBeforeHookCreation"} {
		require.False(t, beforeHookCreation(value), value)
	}
}

func migrationHook(namespace string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]interface{}{"name": "migrate", "namespace": namespace},
		"spec": map[string]interface{}{"template": map[string]interface{}{"spec": map[string]interface{}{
			"restartPolicy": "Never", "containers": []interface{}{map[string]interface{}{"name": "migrate", "image": "example:new"}},
		}}},
	}}
}

// Simulate finalizer/GC delay and real Job immutability. No replacement may be
// applied until the old Job is actually absent, even after DELETE succeeds.
func TestHookReplacementWaitsForDeletionAndDoesNotRepeatRunningJob(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	old := migrationHook("tenant")
	old.SetUID("old-job")
	old.Object["status"] = map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Complete", "status": "True"}}}
	gvr := schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), old)
	deletes, applies := 0, 0
	dyn.PrependReactor("delete", "jobs", func(action ktesting.Action) (bool, runtime.Object, error) {
		deletes++
		deleteAction, ok := action.(ktesting.DeleteAction)
		require.True(t, ok)
		opts := deleteAction.GetDeleteOptions()
		require.Equal(t, metav1.DeletePropagationForeground, *opts.PropagationPolicy)
		require.Equal(t, types.UID("old-job"), *opts.Preconditions.UID)
		require.Equal(t, "tenant", action.GetNamespace())
		old.SetDeletionTimestamp(&metav1.Time{Time: now})
		require.NoError(t, dyn.Tracker().Update(gvr, old, "tenant"))
		return true, nil, nil
	})
	dyn.PrependReactor("patch", "jobs", func(action ktesting.Action) (bool, runtime.Object, error) {
		applies++
		_, err := dyn.Tracker().Get(gvr, "tenant", "migrate")
		require.True(t, apierrors.IsNotFound(err), "never apply over an existing immutable Job")
		obj := migrationHook("tenant")
		obj.SetUID("new-job")
		require.NoError(t, dyn.Tracker().Create(gvr, obj, "tenant"))
		return true, obj, nil
	})
	r := &ReleaseReconciler{Clock: clock.NewFake(now)}
	release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "release", Namespace: "tenant"}, Spec: paprikav1.ReleaseSpec{SyncOptions: &paprikav1.SyncOptions{HookTimeoutSeconds: 60}}}
	resources := []hooks.Resource{{Obj: migrationHook(""), DeletePolicy: "BeforeHookCreation,HookSucceeded", Phase: hooks.PhasePreSync}}
	require.ErrorIs(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync), errHookPhasePending)
	require.Equal(t, 1, deletes)
	require.Zero(t, applies)
	require.Empty(t, release.Status.HookStatuses)
	require.ErrorIs(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync), errHookPhasePending)
	require.Equal(t, 1, deletes, "do not repeatedly delete a terminating hook")
	require.Zero(t, applies)
	require.NoError(t, dyn.Tracker().Delete(gvr, "tenant", "migrate"))
	require.ErrorIs(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync), errHookPhasePending)
	require.Equal(t, 1, applies)
	require.Equal(t, hookStatusRunning, release.Status.HookStatuses[0].Status)
	require.ErrorIs(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync), errHookPhasePending)
	require.Equal(t, 1, deletes)
	require.Equal(t, 1, applies, "a running migration is polled, not recreated")
	live, err := dyn.Resource(gvr).Namespace("tenant").Get(ctx, "migrate", metav1.GetOptions{})
	require.NoError(t, err)
	live.Object["status"] = map[string]interface{}{"conditions": []interface{}{map[string]interface{}{"type": "Complete", "status": "True"}}}
	require.NoError(t, dyn.Tracker().Update(gvr, live, "tenant"))
	require.NoError(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync))
	require.Equal(t, hookStatusSucceeded, release.Status.HookStatuses[0].Status)
	require.NoError(t, r.executeHooks(ctx, release, dyn, resources, hooks.PhasePreSync))
	require.Equal(t, 1, applies)
}

func TestHookDeletionTimeoutAndPermissionFailure(t *testing.T) {
	for _, mode := range []string{"timeout", "forbidden", "uid conflict"} {
		t.Run(mode, func(t *testing.T) {
			now := time.Now()
			old := migrationHook("tenant")
			old.SetUID("old")
			if mode == "timeout" {
				old.SetDeletionTimestamp(&metav1.Time{Time: now.Add(-2 * time.Minute)})
			}
			dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), old)
			dyn.PrependReactor("delete", "jobs", func(ktesting.Action) (bool, runtime.Object, error) {
				if mode == "uid conflict" {
					return true, nil, apierrors.NewConflict(schema.GroupResource{Group: "batch", Resource: "jobs"}, "migrate", errors.New("UID changed"))
				}
				return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "batch", Resource: "jobs"}, "migrate", errors.New("denied"))
			})
			r := &ReleaseReconciler{Clock: clock.NewFake(now)}
			err := r.deleteExistingHook(context.Background(), dyn, old, time.Minute)
			switch mode {
			case "timeout":
				require.ErrorContains(t, err, "deletion timed out")
			case "forbidden":
				require.True(t, apierrors.IsForbidden(err))
			case "uid conflict":
				require.ErrorIs(t, err, errHookPhasePending)
			}
			for _, action := range dyn.Actions() {
				require.NotEqual(t, "patch", action.GetVerb())
			}
		})
	}
}

func TestResyncStartsFreshHookAttemptOnlyForTerminalRelease(t *testing.T) {
	for _, phase := range []paprikav1.ReleasePhase{paprikav1.ReleaseFailed, paprikav1.ReleaseComplete, paprikav1.ReleasePromoting} {
		t.Run(string(phase), func(t *testing.T) {
			scheme := runtime.NewScheme()
			require.NoError(t, paprikav1.AddToScheme(scheme))
			release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: "release", Namespace: "tenant", Annotations: map[string]string{resyncAnnotation: "retry"}}, Status: paprikav1.ReleaseStatus{
				Phase: phase, HookStatuses: []paprikav1.HookStatus{{Kind: "Job", Name: "migrate", Namespace: "tenant", Phase: "PreSync", Status: hookStatusFailed}},
				Conditions: []metav1.Condition{{Type: "Failed", Status: metav1.ConditionTrue, Reason: "PromotionFailed"}},
			}}
			c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(release).WithStatusSubresource(release).Build()
			r := &ReleaseReconciler{client: c, Scheme: scheme}
			var result string
			_, handled, err := r.handleResyncAnnotation(context.Background(), release, &result)
			require.NoError(t, err)
			require.True(t, handled)
			stored := &paprikav1.Release{}
			require.NoError(t, c.Get(context.Background(), types.NamespacedName{Name: release.Name, Namespace: release.Namespace}, stored))
			if phase == paprikav1.ReleasePromoting {
				require.Len(t, stored.Status.HookStatuses, 1)
			} else {
				require.Equal(t, paprikav1.ReleasePending, stored.Status.Phase)
				require.Empty(t, stored.Status.HookStatuses)
				require.Empty(t, stored.Status.Conditions)
			}
		})
	}
}

func TestApplicationPhaseConditionsDoNotContradictRecovery(t *testing.T) {
	r := &ApplicationReconciler{}
	app := &paprikav1.Application{ObjectMeta: metav1.ObjectMeta{Name: "sfh", Generation: 7}}
	for _, phase := range []paprikav1.ApplicationPhase{paprikav1.ApplicationHealthy, paprikav1.ApplicationDegraded, paprikav1.ApplicationPromoting, paprikav1.ApplicationHealthy} {
		require.True(t, r.setApplicationPhase(context.Background(), app, phase, "Transition", "test"))
		for _, condition := range app.Status.Conditions {
			require.Equal(t, app.Generation, condition.ObservedGeneration)
			if condition.Type == string(phase) {
				require.Equal(t, metav1.ConditionTrue, condition.Status)
			} else {
				require.Equal(t, metav1.ConditionFalse, condition.Status)
			}
		}
	}
}
