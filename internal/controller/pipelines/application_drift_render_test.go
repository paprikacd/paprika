package pipelines

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// newFormatSourceHash is the source hash an application records once its render
// configuration is folded in (dns/dns on omega-ha): the commit, then the
// render-config-v1 digest of the chart content and the template's render
// configuration. Computed here from the definition, not by the code under test.
func newFormatSourceHash(t *testing.T, commit, chartContent string, spec *paprikav1.TemplateSpec) string {
	t.Helper()
	configHash, err := remoteRenderConfigHash(spec)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte(chartContent + "\n" + configHash))
	return commit + ":" + remoteRenderHashPrefix + hex.EncodeToString(sum[:])
}

// On a new-format source hash the render configuration is part of the content
// identity, so the drift render may reuse a resolved commit only when both the
// chart content and the render configuration match the release's.
func TestDesiredManifests_DriftRenderNewFormatSourceHash(t *testing.T) {
	t.Parallel()

	const (
		releaseRevision = "a230f4e15455a609a230f4e15455a609a230f4e1"
		tipRevision     = "29a3f4074d6417f9e3294a044f30de6f8685c4a0"
	)
	newApp := func(values string) *paprikav1.Application {
		return &paprikav1.Application{
			ObjectMeta: metav1.ObjectMeta{Name: "dns", Namespace: "dns"},
			Spec: paprikav1.ApplicationSpec{Source: paprikav1.ApplicationSource{
				Type: paprikav1.SourceTypeGit, RepoURL: "https://github.com/skunkworq/dns.git",
				Revision: "main", Path: "deploy/chart", FetchTTL: "45s", ValuesFile: values,
			}},
		}
	}
	cases := []struct {
		name string
		// releaseValues is the render configuration the release was made with;
		// the stored Template always carries "replicaCount: 2".
		releaseValues    string
		resolvedRawChart string
		want             string
	}{
		{name: "same chart content and render configuration", releaseValues: "replicaCount: 2\n", resolvedRawChart: "chartcontent0000", want: tipRevision},
		{name: "chart content changed", releaseValues: "replicaCount: 2\n", resolvedRawChart: "chartcontent1111", want: releaseRevision},
		{name: "render configuration changed since the release", releaseValues: "replicaCount: 1\n", resolvedRawChart: "chartcontent0000", want: releaseRevision},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ctx := context.Background()
			app := newApp("replicaCount: 2\n")
			template := &paprikav1.Template{
				ObjectMeta: metav1.ObjectMeta{Name: "dns-template", Namespace: "dns"},
				Spec:       buildTemplateSpec(app),
			}
			releaseSpec := buildTemplateSpec(newApp(tc.releaseValues))
			releaseHash := newFormatSourceHash(t, "a230f4e15455a609", "chartcontent0000", &releaseSpec)
			app.Status = paprikav1.ApplicationStatus{SourceHash: releaseHash, SourceRevision: releaseRevision, ReleaseRef: "dns-release-old"}
			release := &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{
				Name: "dns-release-old", Namespace: "dns",
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
			// The resolver reports the raw "<commit>:<chart dir hash>".
			r.sourceResolveCache().put(sourceResolveKey(template), "29a3f4074d641700:"+tc.resolvedRawChart, tipRevision, time.Minute)

			_, err := r.desiredManifests(ctx, app)
			require.NoError(t, err)
			require.NotNil(t, renderer.captured)
			require.Equal(t, tc.want, renderer.captured.Spec.Git.Revision)
			require.Equal(t, releaseHash, renderer.captured.Status.SourceHash)
		})
	}
}
