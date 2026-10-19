package pipelines

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ringFixture builds an application mid-flow on its first ring, with the first
// ring's release complete.
func ringFixture(t *testing.T, autoPromote bool, degraded bool) (*ApplicationReconciler, *paprikav1.Application, client.Client) {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))

	app := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "rings", Namespace: "checkout", UID: types.UID("app-uid")},
		Spec: paprikav1.ApplicationSpec{
			Project: "default",
			Source:  paprikav1.ApplicationSource{Type: paprikav1.SourceTypeInline},
			Stages: []paprikav1.ApplicationPromotionStage{
				{Name: "eu", Ring: 1, AutoPromote: autoPromote},
				{Name: "us", Ring: 2, AutoPromote: true},
			},
		},
		Status: paprikav1.ApplicationStatus{
			Phase:        paprikav1.ApplicationHealthy,
			CurrentStage: "eu",
			ReleaseRef:   applicationReleaseName(&paprikav1.Application{ObjectMeta: metav1.ObjectMeta{Name: "rings"}, Spec: paprikav1.ApplicationSpec{Stages: []paprikav1.ApplicationPromotionStage{{Name: "eu", Ring: 1}, {Name: "us", Ring: 2}}}}, nil),
			Health:       paprikav1.HealthHealthy,
		},
	}
	// The stable name is used when no identity applies; recompute from the real
	// app so the fixture matches production naming.
	app.Status.ReleaseRef = applicationReleaseName(app, currentStageIn(app))
	if degraded {
		app.Status.ResourceHealth = []paprikav1.ResourceHealth{{Kind: "Deployment", Name: "web", Health: string(paprikav1.HealthDegraded)}}
	}

	completed := &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: "checkout"},
		Spec: paprikav1.ReleaseSpec{
			Target:         "rings-eu",
			ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "rings-bundle"},
		},
		Status: paprikav1.ReleaseStatus{Phase: paprikav1.ReleaseComplete},
	}

	c := fake.NewClientBuilder().WithScheme(scheme).
		WithObjects(app, completed).
		WithStatusSubresource(&paprikav1.Application{}, &paprikav1.Release{}).
		Build()
	return &ApplicationReconciler{client: c, Scheme: scheme}, app, c
}

// TestRingPromotionCreatesTheNextRingsRelease covers the flow that previously
// did nothing: a completed, healthy ring with autoPromote releases the next
// ring under its own name.
func TestRingPromotionCreatesTheNextRingsRelease(t *testing.T) {
	t.Parallel()

	r, app, c := ringFixture(t, true, false)
	firstRelease := app.Status.ReleaseRef

	promoted, err := r.promoteToNextRing(context.Background(), app, &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "rings-bundle"}},
	})
	require.NoError(t, err)
	require.True(t, promoted)

	require.Equal(t, "us", app.Status.CurrentStage)
	require.NotEqual(t, firstRelease, app.Status.ReleaseRef, "the next ring needs its own release object")

	var created paprikav1.Release
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Namespace: "checkout", Name: app.Status.ReleaseRef}, &created))
	require.Equal(t, "rings-us", created.Spec.Target)
	require.NotNil(t, created.Spec.ManifestSource, "the next ring deploys the same bundle")
	require.Equal(t, "rings-bundle", created.Spec.ManifestSource.ConfigMapRef)

	stored := &paprikav1.Application{}
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Namespace: "checkout", Name: "rings"}, stored))
	require.Equal(t, "us", stored.Status.CurrentStage, "the ring advance must be persisted")
}

// TestRingPromotionHoldsOnADegradedRing keeps a broken ring from releasing the
// next one.
func TestRingPromotionHoldsOnADegradedRing(t *testing.T) {
	t.Parallel()

	r, app, _ := ringFixture(t, true, true)
	promoted, err := r.promoteToNextRing(context.Background(), app, &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "rings-bundle"}},
	})
	require.NoError(t, err)
	require.False(t, promoted)
	require.Equal(t, "eu", app.Status.CurrentStage)
}

// TestRingPromotionRequiresAutoPromote is the manual gate: without it the ring
// waits for an operator however healthy it is.
func TestRingPromotionRequiresAutoPromote(t *testing.T) {
	t.Parallel()

	r, app, _ := ringFixture(t, false, false)
	promoted, err := r.promoteToNextRing(context.Background(), app, &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "rings-bundle"}},
	})
	require.NoError(t, err)
	require.False(t, promoted)
	require.Equal(t, "eu", app.Status.CurrentStage)
}

// TestRingPromotionStopsAtTheLastRing covers the end of a pipeline: a completed
// final ring has nothing to release.
func TestRingPromotionStopsAtTheLastRing(t *testing.T) {
	t.Parallel()

	r, app, _ := ringFixture(t, true, false)
	app.Status.CurrentStage = "us"
	promoted, err := r.promoteToNextRing(context.Background(), app, &paprikav1.Release{
		ObjectMeta: metav1.ObjectMeta{Name: app.Status.ReleaseRef, Namespace: "checkout"},
		Spec:       paprikav1.ReleaseSpec{ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "rings-bundle"}},
	})
	require.NoError(t, err)
	require.False(t, promoted)
}

// TestStageOrderFollowsRingNotDeclarationOrder pins the ordering the flow
// depends on: rings can be declared out of order and a tie holds declaration
// order so parallel stages in one ring stay stable.
func TestStageOrderFollowsRingNotDeclarationOrder(t *testing.T) {
	t.Parallel()

	app := &paprikav1.Application{Spec: paprikav1.ApplicationSpec{Stages: []paprikav1.ApplicationPromotionStage{
		{Name: "prod", Ring: 3},
		{Name: "dev-a", Ring: 1},
		{Name: "dev-b", Ring: 1},
	}}}
	ordered := stageOrder(app)
	require.Equal(t, []string{"dev-a", "dev-b", "prod"}, []string{ordered[0].Name, ordered[1].Name, ordered[2].Name})

	stage := currentStageIn(app)
	require.Equal(t, "dev-a", stage.Name, "an application without a recorded stage starts at the lowest ring")
}

// TestNewSourceRevisionRestartsTheRingFlow keeps a commit made while the fleet
// sits on the last ring from deploying straight to production.
func TestNewSourceRevisionRestartsTheRingFlow(t *testing.T) {
	t.Parallel()

	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	app := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "rings", Namespace: "checkout"},
		Spec: paprikav1.ApplicationSpec{
			Source: paprikav1.ApplicationSource{Type: paprikav1.SourceTypeGit},
			Stages: []paprikav1.ApplicationPromotionStage{{Name: "eu", Ring: 1}, {Name: "us", Ring: 2}},
		},
		Status: paprikav1.ApplicationStatus{CurrentStage: "us"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).
		WithStatusSubresource(&paprikav1.Application{}).Build()
	r := &ApplicationReconciler{client: c, Scheme: scheme}

	_, err := r.startNewReleaseFlow(context.Background(), app, false, "ReleaseSpecChanged", "new revision")
	require.NoError(t, err)
	require.Empty(t, app.Status.CurrentStage, "a new revision starts at the first ring")

	// A manual sync retries the ring the operator is looking at.
	app.Status.CurrentStage = "us"
	_, err = r.startNewReleaseFlow(context.Background(), app, true, "ManualSync", "operator asked")
	require.NoError(t, err)
	require.Equal(t, "us", app.Status.CurrentStage)
}

// TestMultiRingReleaseNamesAreDistinct guards the naming rule that makes ring
// promotion possible without a pollable source identity.
func TestMultiRingReleaseNamesAreDistinct(t *testing.T) {
	t.Parallel()

	app := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "rings"},
		Spec: paprikav1.ApplicationSpec{Stages: []paprikav1.ApplicationPromotionStage{
			{Name: "eu", Ring: 1}, {Name: "us", Ring: 2},
		}},
	}
	eu := applicationReleaseName(app, &app.Spec.Stages[0])
	us := applicationReleaseName(app, &app.Spec.Stages[1])
	require.NotEqual(t, eu, us)

	single := &paprikav1.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "solo"},
		Spec:       paprikav1.ApplicationSpec{Stages: []paprikav1.ApplicationPromotionStage{{Name: "only", Ring: 1}}},
	}
	require.Equal(t, stableApplicationReleaseName("solo"), applicationReleaseName(single, &single.Spec.Stages[0]),
		"a single-ring application keeps its existing release name")
}

var _ = apierrors.IsNotFound

// TestRingAdvanceDoesNotClobberAPublisher covers the concurrency rule for
// inline applications: the release reference belongs to whoever publishes the
// bundle, so a promotion that finds a newer reference leaves it alone.
func TestRingAdvanceDoesNotClobberAPublisher(t *testing.T) {
	t.Parallel()

	r, app, c := ringFixture(t, true, false)
	completed := app.Status.ReleaseRef

	// A publisher selects a replacement release while the ring completes.
	var stored paprikav1.Application
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Namespace: "checkout", Name: "rings"}, &stored))
	stored.Status.ReleaseRef = "published-by-operator"
	require.NoError(t, c.Status().Update(context.Background(), &stored))

	require.NoError(t, r.persistRingAdvance(context.Background(), app, completed, "us", "rings-next"))

	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Namespace: "checkout", Name: "rings"}, &stored))
	require.Equal(t, "published-by-operator", stored.Status.ReleaseRef)
	require.Equal(t, "eu", stored.Status.CurrentStage, "the ring must not advance past an unreleased publish")
}
