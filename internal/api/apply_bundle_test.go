package apiserver

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
	"github.com/benebsworth/paprika/internal/policy"
)

// fakeEvaluator is a test double for apiserver.Evaluator.
type fakeEvaluator struct {
	result *policy.EvaluationResult
	err    error
}

var _ Evaluator = (*fakeEvaluator)(nil)

func (f *fakeEvaluator) Evaluate(_ context.Context, _ []byte, _ policy.EvaluateOptions) (*policy.EvaluationResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.result != nil {
		return f.result, nil
	}
	return &policy.EvaluationResult{Passed: true}, nil
}

func newApplyBundleClient(t *testing.T) client.Client {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
	require.NoError(t, policyv1alpha1.AddToScheme(scheme))

	return fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(&pipelinesv1alpha1.Application{}, &pipelinesv1alpha1.Release{}).
		Build()
}

func sampleManifests() []byte {
	return []byte(`apiVersion: v1
kind: ConfigMap
metadata:
  name: sample-cm
data:
  key: value
`)
}

func TestApplyBundle_Success(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{result: &policy.EvaluationResult{Passed: true}}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "test-ns",
		Name:      "test-app",
		Manifests: sampleManifests(),
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.False(t, resp.Msg.Blocked)
	require.NotNil(t, resp.Msg.Application)
	require.NotNil(t, resp.Msg.Release)

	// Namespace should have been created.
	var ns corev1.Namespace
	require.NoError(t, c.Get(ctx, client.ObjectKey{Name: "test-ns"}, &ns))

	// Application should exist.
	var app pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "test-ns", Name: "test-app"}, &app))
	require.Equal(t, "default", app.Spec.Project)
	require.Equal(t, resp.Msg.Release.Name, app.Status.ReleaseRef)

	// Stage should exist.
	var stage pipelinesv1alpha1.Stage
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "test-ns", Name: "test-app-default"}, &stage))

	// Release should exist.
	var release pipelinesv1alpha1.Release
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "test-ns", Name: resp.Msg.Release.Name}, &release))

	// Manifest snapshot ConfigMap should exist and be owned by the release.
	var cm corev1.ConfigMap
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "test-ns", Name: resp.Msg.Release.Name + "-manifests"}, &cm))
	require.Len(t, cm.OwnerReferences, 1)
	require.Equal(t, release.UID, cm.OwnerReferences[0].UID)
}

func TestApplyBundleStageCarriesExactApplicationControllerOwner(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		stage *pipelinesv1alpha1.Stage
	}{
		{name: "created"},
		{
			name: "repairs missing owner",
			stage: &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
				Namespace: "owner-ns-missing",
				Name:      "owner-app-default",
			}},
		},
		{
			name: "repairs stale application owner",
			stage: &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
				Namespace: "owner-ns-stale",
				Name:      "owner-app-default",
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: pipelinesv1alpha1.GroupVersion.String(),
					Kind:       "Application",
					Name:       "owner-app",
					UID:        types.UID("stale-app-uid"),
					Controller: ptr(true),
				}},
			}},
		},
		{
			name: "promotes matching non controller owner",
			stage: &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
				Namespace: "owner-ns-non-controller",
				Name:      "owner-app-default",
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: pipelinesv1alpha1.GroupVersion.String(),
					Kind:       "Application",
					Name:       "owner-app",
					UID:        types.UID("current-app-uid"),
				}},
			}},
		},
		{
			name: "repairs stale application api version",
			stage: &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
				Namespace: "owner-ns-stale-version",
				Name:      "owner-app-default",
				OwnerReferences: []metav1.OwnerReference{{
					APIVersion: "pipelines.paprika.io/v1beta1",
					Kind:       "Application",
					Name:       "owner-app",
					UID:        types.UID("current-app-uid"),
					Controller: ptr(true),
				}},
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			namespace := "owner-ns-created"
			if test.stage != nil {
				namespace = test.stage.Namespace
			}
			ctx := context.Background()
			c := newApplyBundleClient(t)
			app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{
				Namespace: namespace,
				Name:      "owner-app",
				UID:       types.UID("current-app-uid"),
			}}
			require.NoError(t, c.Create(ctx, app))
			if test.stage != nil {
				require.NoError(t, c.Create(ctx, test.stage.DeepCopy()))
			}

			srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{
				result: &policy.EvaluationResult{Passed: true},
			}))
			_, err := srv.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
				Namespace: namespace,
				Name:      app.Name,
				Manifests: sampleManifests(),
			}))
			require.NoError(t, err)

			var stage pipelinesv1alpha1.Stage
			require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: namespace, Name: "owner-app-default"}, &stage))
			requireExactApplicationControllerOwner(t, stage.OwnerReferences, app)
		})
	}
}

func TestApplyBundleStageRejectsUnrelatedControllerConflict(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{
		Namespace: "owner-conflict",
		Name:      "owner-app",
		UID:       types.UID("current-app-uid"),
	}}
	conflictingOwner := metav1.OwnerReference{
		APIVersion: "apps/v1",
		Kind:       "Deployment",
		Name:       "unrelated",
		UID:        types.UID("unrelated-uid"),
		Controller: ptr(true),
	}
	stage := &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
		Namespace:       app.Namespace,
		Name:            app.Name + "-default",
		OwnerReferences: []metav1.OwnerReference{conflictingOwner},
	}}
	require.NoError(t, c.Create(ctx, app))
	require.NoError(t, c.Create(ctx, stage))

	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{
		result: &policy.EvaluationResult{Passed: true},
	}))
	_, err := srv.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: app.Namespace,
		Name:      app.Name,
		Manifests: sampleManifests(),
	}))
	require.Error(t, err)
	require.ErrorContains(t, err, "stage")

	var retained pipelinesv1alpha1.Stage
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(stage), &retained))
	require.Equal(t, []metav1.OwnerReference{conflictingOwner}, retained.OwnerReferences)
}

func TestApplyBundleStageConflictIsPreflightedBeforeApplicationMutation(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	stage := &pipelinesv1alpha1.Stage{ObjectMeta: metav1.ObjectMeta{
		Namespace: "preflight-conflict",
		Name:      "new-app-default",
		OwnerReferences: []metav1.OwnerReference{{
			APIVersion: "apps/v1",
			Kind:       "Deployment",
			Name:       "unrelated",
			UID:        types.UID("unrelated-uid"),
			Controller: ptr(true),
		}},
	}}
	require.NoError(t, c.Create(ctx, stage))
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{
		result: &policy.EvaluationResult{Passed: true},
	}))

	_, err := srv.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: stage.Namespace,
		Name:      "new-app",
		Manifests: sampleManifests(),
	}))
	require.Error(t, err)
	var app pipelinesv1alpha1.Application
	err = c.Get(ctx, client.ObjectKey{Namespace: stage.Namespace, Name: "new-app"}, &app)
	require.True(t, client.IgnoreNotFound(err) == nil && err != nil, "application must not be created before ownership preflight")
}

func TestApplyBundleIdempotentCompleteReleaseRepairsStageOwner(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{
		Namespace: "idempotent-owner",
		Name:      "owner-app",
		UID:       types.UID("owner-app-uid"),
	}}
	require.NoError(t, c.Create(ctx, app))
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{
		result: &policy.EvaluationResult{Passed: true},
	}))
	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: app.Namespace,
		Name:      app.Name,
		Manifests: sampleManifests(),
	})
	first, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)

	var release pipelinesv1alpha1.Release
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: first.Msg.Release.Name}, &release))
	release.Status.Phase = pipelinesv1alpha1.ReleaseComplete
	require.NoError(t, c.Status().Update(ctx, &release))
	var stage pipelinesv1alpha1.Stage
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-default"}, &stage))
	stage.OwnerReferences = nil
	require.NoError(t, c.Update(ctx, &stage))

	_, err = srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(&stage), &stage))
	requireExactApplicationControllerOwner(t, stage.OwnerReferences, app)
}

func requireExactApplicationControllerOwner(
	t *testing.T,
	owners []metav1.OwnerReference,
	app *pipelinesv1alpha1.Application,
) {
	t.Helper()
	controllers := make([]metav1.OwnerReference, 0, len(owners))
	for i := range owners {
		if owners[i].Controller != nil && *owners[i].Controller {
			controllers = append(controllers, owners[i])
		}
	}
	require.Equal(t, []metav1.OwnerReference{{
		APIVersion: pipelinesv1alpha1.GroupVersion.String(),
		Kind:       "Application",
		Name:       app.Name,
		UID:        app.UID,
		Controller: ptr(true),
	}}, controllers)
	matchingIdentity := 0
	for i := range owners {
		if owners[i].Kind == "Application" && owners[i].Name == app.Name {
			matchingIdentity++
		}
	}
	require.Equal(t, 1, matchingIdentity, "matching non-controller owners must be promoted, not duplicated")
}

func TestApplyBundle_BlockedByPolicy(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{
		result: &policy.EvaluationResult{
			Passed:  false,
			Blocked: true,
			Message: "policy no-latest failed",
			Results: []policy.Result{
				{
					Name:     "no-latest",
					Severity: "high",
					Action:   "enforce",
					Passed:   false,
					Message:  "container uses latest tag",
				},
			},
		},
	}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "blocked-ns",
		Name:      "blocked-app",
		Manifests: sampleManifests(),
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.True(t, resp.Msg.Blocked)
	require.Contains(t, resp.Msg.BlockReason, "no-latest")
	require.Len(t, resp.Msg.PolicyResults, 1)
	require.Equal(t, "enforce", resp.Msg.PolicyResults[0].Action)

	// No mutating resources should have been created.
	var apps pipelinesv1alpha1.ApplicationList
	require.NoError(t, c.List(ctx, &apps))
	require.Empty(t, apps.Items)

	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, c.List(ctx, &releases))
	require.Empty(t, releases.Items)

	var cms corev1.ConfigMapList
	require.NoError(t, c.List(ctx, &cms))
	require.Empty(t, cms.Items)
}

func TestApplyBundle_DryRun(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{result: &policy.EvaluationResult{Passed: true}}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "dryrun-ns",
		Name:      "dryrun-app",
		Manifests: sampleManifests(),
		DryRun:    true,
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.False(t, resp.Msg.Blocked)
	require.NotNil(t, resp.Msg.Application)
	require.NotNil(t, resp.Msg.Release)

	// Only the namespace is created during dry-run; no application/stage/release/configmap.
	var apps pipelinesv1alpha1.ApplicationList
	require.NoError(t, c.List(ctx, &apps))
	require.Empty(t, apps.Items)

	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, c.List(ctx, &releases))
	require.Empty(t, releases.Items)

	var stages pipelinesv1alpha1.StageList
	require.NoError(t, c.List(ctx, &stages))
	require.Empty(t, stages.Items)

	var cms corev1.ConfigMapList
	require.NoError(t, c.List(ctx, &cms))
	require.Empty(t, cms.Items)
}

// overrideEvaluator asserts that policy override actions are translated into
// policy.EvaluateOptions and uses the override to downgrade an enforce failure
// to a warn.
type overrideEvaluator struct{}

var _ Evaluator = overrideEvaluator{}

func (overrideEvaluator) Evaluate(_ context.Context, _ []byte, opts policy.EvaluateOptions) (*policy.EvaluationResult, error) {
	if opts.PolicyOverrides["check-labels"] == policy.WarnAction {
		return &policy.EvaluationResult{
			Passed: true,
			Results: []policy.Result{
				{
					Name:     "check-labels",
					Severity: "medium",
					Action:   "warn",
					Passed:   false,
					Message:  "label owner is missing",
				},
			},
		}, nil
	}

	return &policy.EvaluationResult{
		Passed:  false,
		Blocked: true,
		Message: "policy check-labels failed",
		Results: []policy.Result{
			{
				Name:     "check-labels",
				Severity: "medium",
				Action:   "enforce",
				Passed:   false,
				Message:  "label owner is missing",
			},
		},
	}, nil
}

func TestApplyBundle_PolicyOverride(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(overrideEvaluator{}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace:       "override-ns",
		Name:            "override-app",
		Manifests:       sampleManifests(),
		PolicyOverrides: map[string]string{"check-labels": "warn"},
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.False(t, resp.Msg.Blocked)
	require.Len(t, resp.Msg.PolicyResults, 1)
	require.Equal(t, "warn", resp.Msg.PolicyResults[0].Action)

	// Resources should still be applied because the policy only warned.
	var app pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "override-ns", Name: "override-app"}, &app))

	var release pipelinesv1alpha1.Release
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "override-ns", Name: resp.Msg.Release.Name}, &release))
}

func TestApplyBundle_DeriveNameFromManifest(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{result: &policy.EvaluationResult{Passed: true}}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "derive-ns",
		Name:      "",
		Manifests: sampleManifests(),
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.False(t, resp.Msg.Blocked)
	require.Equal(t, "sample-cm", resp.Msg.Application.Name)

	var app pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "derive-ns", Name: "sample-cm"}, &app))
}

func TestApplyBundle_IdempotentReapply(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{result: &policy.EvaluationResult{Passed: true}}))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "idempotent-ns",
		Name:      "idempotent-app",
		Manifests: sampleManifests(),
	})

	resp1, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp1)
	existingReleaseName := resp1.Msg.Release.Name

	var release pipelinesv1alpha1.Release
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "idempotent-ns", Name: existingReleaseName}, &release))
	release.Status.Phase = pipelinesv1alpha1.ReleaseComplete
	require.NoError(t, c.Status().Update(ctx, &release))

	resp2, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp2)
	require.False(t, resp2.Msg.Blocked)
	require.Equal(t, existingReleaseName, resp2.Msg.Release.Name)

	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, c.List(ctx, &releases))
	require.Len(t, releases.Items, 1)
}

func TestApplyBundle_SupersedesPreviousTerminalRelease(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	c := newApplyBundleClient(t)
	srv := NewPaprikaServer(c, nil, WithPolicyEvaluator(&fakeEvaluator{result: &policy.EvaluationResult{Passed: true}}))

	app := &pipelinesv1alpha1.Application{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "super-app",
			Namespace: "supersede-ns",
		},
		Spec: pipelinesv1alpha1.ApplicationSpec{
			Project: "default",
		},
	}
	require.NoError(t, c.Create(ctx, app))

	oldRelease := &pipelinesv1alpha1.Release{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "super-app-release-old",
			Namespace: "supersede-ns",
			Annotations: map[string]string{
				bundleSHAAnnotation: "old-sha",
			},
		},
		Spec: pipelinesv1alpha1.ReleaseSpec{
			Target: "super-app-default",
		},
	}
	require.NoError(t, c.Create(ctx, oldRelease))
	oldRelease.Status.Phase = pipelinesv1alpha1.ReleaseComplete
	require.NoError(t, c.Status().Update(ctx, oldRelease))

	app.Status.ReleaseRef = oldRelease.Name
	require.NoError(t, c.Status().Update(ctx, app))

	req := connect.NewRequest(&paprikav1.ApplyBundleRequest{
		Namespace: "supersede-ns",
		Name:      "super-app",
		Manifests: sampleManifests(),
	})

	resp, err := srv.ApplyBundle(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.False(t, resp.Msg.Blocked)
	require.NotEqual(t, oldRelease.Name, resp.Msg.Release.Name)

	var updatedOld pipelinesv1alpha1.Release
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "supersede-ns", Name: oldRelease.Name}, &updatedOld))
	require.Equal(t, pipelinesv1alpha1.ReleaseSuperseded, updatedOld.Status.Phase)

	var appUpdated pipelinesv1alpha1.Application
	require.NoError(t, c.Get(ctx, client.ObjectKey{Namespace: "supersede-ns", Name: "super-app"}, &appUpdated))
	require.Equal(t, resp.Msg.Release.Name, appUpdated.Status.ReleaseRef)

	var releases pipelinesv1alpha1.ReleaseList
	require.NoError(t, c.List(ctx, &releases))
	require.Len(t, releases.Items, 2)
}
