package pipelines

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// The drift render of brandbrain-api on 2026-10-29 pinned the active release's
// e5e9b6d48, one commit behind the mirrored tip 29a3f4074 whose chart is
// identical, and the repo server spent 20 minutes fetching e5e9b6d48's 10 GB
// tree. A content-identical commit from the poll's resolve renders the same
// manifests without that fetch; anything else keeps the release's commit.
func TestDesiredManifests_DriftRenderUsesContentIdenticalResolvedCommit(t *testing.T) {
	t.Parallel()

	const (
		releaseHash     = "e5e9b6d48aaaaaaa:chartcontent0000"
		releaseRevision = "e5e9b6d48e5e9b6d48e5e9b6d48e5e9b6d48e5e9"
		tipRevision     = "29a3f4074d6417f9e3294a044f30de6f8685c4a0"
	)
	cases := []struct {
		name       string
		cachedHash string
		cacheTTL   time.Duration
		want       string
	}{
		{name: "tip with the release's chart content", cachedHash: "29a3f4074d641700:chartcontent0000", cacheTTL: time.Minute, want: tipRevision},
		{name: "tip whose chart changed", cachedHash: "de0485d97670000:chartcontent1111", cacheTTL: time.Minute, want: releaseRevision},
		{name: "nothing resolved yet", want: releaseRevision},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ctx := context.Background()
			app := &paprikav1.Application{
				ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api", Namespace: "brandbrain"},
				Spec: paprikav1.ApplicationSpec{Source: paprikav1.ApplicationSource{
					Type: paprikav1.SourceTypeGit, RepoURL: "https://github.com/skunkworq/brandbrain.git",
					Revision: "main", Path: "deploy/kubernetes/chart", FetchTTL: "45s",
				}},
				Status: paprikav1.ApplicationStatus{
					SourceHash: releaseHash, SourceRevision: releaseRevision, ReleaseRef: "brandbrain-api-release-old",
				},
			}
			template := &paprikav1.Template{
				ObjectMeta: metav1.ObjectMeta{Name: "brandbrain-api-template", Namespace: "brandbrain"},
				Spec:       buildTemplateSpec(app),
			}
			release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{
				Name: "brandbrain-api-release-old", Namespace: "brandbrain",
				Annotations: map[string]string{sourceHashAnnotation: releaseHash, sourceRevisionAnnotation: releaseRevision},
			}}
			scheme := runtime.NewScheme()
			require.NoError(t, paprikav1.AddToScheme(scheme))
			renderer := &captureTemplateRenderer{}
			r := &ApplicationReconciler{
				client:           fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, template, release).Build(),
				TemplateRenderer: renderer,
				SourceResolveTTL: time.Minute,
			}
			if tc.cachedHash != "" {
				r.sourceResolveCache().put(sourceResolveKey(template), tc.cachedHash, tipRevision, tc.cacheTTL)
			}

			_, err := r.desiredManifests(ctx, app)
			require.NoError(t, err)
			require.NotNil(t, renderer.captured)
			require.Equal(t, tc.want, renderer.captured.Spec.Git.Revision)
			require.Equal(t, tc.want, renderer.captured.Status.SourceRevision)
			require.Equal(t, releaseHash, renderer.captured.Status.SourceHash, "the render keeps the release's content identity")
		})
	}
}
