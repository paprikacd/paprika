package pipelines

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// rolloutDiffFixture returns a non-promotion inline Application whose active
// Release and snapshot match its accepted manifestHash.
func rolloutDiffFixture() (*api.Application, *api.Release, *corev1.ConfigMap) {
	snapshot := artifactTestSnapshot("prod", "prod")
	hash := inlineArtifactPayloadHash([]byte(snapshot.Data["manifests.yaml"]))
	release := &api.Release{
		ObjectMeta: metav1.ObjectMeta{Name: "api-release-old", Namespace: "prod",
			Annotations: map[string]string{sourceRevisionAnnotation: promotionTestRevision, sourceHashAnnotation: hash}},
		Spec:   api.ReleaseSpec{ManifestSource: &api.ManifestSource{ConfigMapRef: snapshot.Name, Artifact: artifactTestSpec()}},
		Status: api.ReleaseStatus{RenderedManifestSnapshot: snapshot.Name},
	}
	app := &api.Application{
		ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "prod", UID: "api-uid"},
		Spec: api.ApplicationSpec{Source: api.ApplicationSource{Type: api.SourceTypeInline, TargetNamespace: "prod",
			Inline: &api.InlineSourceSpec{ConfigMapRef: snapshot.Name, Artifact: artifactTestSpec(), ManifestHash: hash}}},
		Status: api.ApplicationStatus{ReleaseRef: release.Name},
	}
	return app, release, snapshot
}

func TestInlineSnapshotValidationSeparatesRolloutFromIntegrityFailures(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		mutate     func(*api.Application, *api.Release, *corev1.ConfigMap)
		superseded bool
		ok         bool
	}{
		{name: "active release matches the accepted artifact", ok: true},
		{name: "a new artifact is accepted before its release is active", superseded: true,
			mutate: func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
				a.Spec.Source.Inline.ManifestHash = "next-artifact-hash"
			}},
		{name: "the application no longer has an inline artifact",
			mutate: func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Spec.Source.Inline.Artifact = nil }},
		{name: "the snapshot differs from the frozen release hash",
			mutate: func(_ *api.Application, _ *api.Release, s *corev1.ConfigMap) {
				s.Data["manifests.yaml"] = artifactTestPayload("prod", "substituted", artifactTestImage)
			}},
		{name: "the snapshot is mutable",
			mutate: func(_ *api.Application, _ *api.Release, s *corev1.ConfigMap) { s.Immutable = nil }},
		{name: "the release revision differs from the artifact",
			mutate: func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) {
				r.Annotations[sourceRevisionAnnotation] = "0000000000000000000000000000000000000000"
			}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app, release, snapshot := rolloutDiffFixture()
			if test.mutate != nil {
				test.mutate(app, release, snapshot)
			}
			err := validateInlineArtifactApplicationSnapshot(snapshot, release, app)
			if test.ok {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			require.Equal(t, test.superseded, errors.Is(err, errInlineReleaseSuperseded),
				"only a moved-ahead manifestHash is a rollout; every integrity failure stays an error")
		})
	}
}

func TestApplicationDiffDuringInlineRolloutReportsSupersededRelease(t *testing.T) {
	t.Parallel()
	app, release, snapshot := rolloutDiffFixture()
	app.Spec.Source.Inline.ManifestHash = "next-artifact-hash"
	r := inlineArtifactReconciler(t, app, release, snapshot)

	_, err := r.computeApplicationDiff(context.Background(), app, nil)
	require.ErrorIs(t, err, errInlineReleaseSuperseded, "evaluateDiff must be able to recognize the rollout window through the error chain")

	app, release, snapshot = rolloutDiffFixture()
	r = inlineArtifactReconciler(t, app, release, snapshot)
	manifests, err := r.loadInlineManifests(context.Background(), app)
	require.NoError(t, err)
	require.Equal(t, snapshot.Data["manifests.yaml"], string(manifests))
}
