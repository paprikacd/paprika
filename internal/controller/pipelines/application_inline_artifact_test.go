package pipelines

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	kptr "k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const artifactTestImage = "ghcr.io/example/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func artifactTestSpec() *api.InlineArtifact {
	return &api.InlineArtifact{Repository: "https://example.test/api.git", Revision: promotionTestRevision, Images: map[string]api.ArtifactImageReference{"backend": artifactTestImage}}
}

func artifactTestPayload(namespace, environment, image string) string {
	return fmt.Sprintf(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: %s
  labels:
    app.kubernetes.io/component: backend
spec:
  template:
    spec:
      containers:
        - name: backend
          image: %s
          env:
            - name: ENVIRONMENT
              value: %s
`, namespace, image, environment)
}

func artifactTestSnapshot(namespace, environment string) *corev1.ConfigMap {
	return &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "bundle", Namespace: namespace}, Immutable: kptr.To(true), Data: map[string]string{"manifests.yaml": artifactTestPayload(namespace, environment, artifactTestImage)}}
}

func inlineArtifactFixture() (*api.Application, *api.Application, *api.Release, *corev1.ConfigMap, *corev1.ConfigMap) {
	target, upstream, release := promotionFixture()
	for _, app := range []*api.Application{upstream, target} {
		app.Spec.Source = api.ApplicationSource{Type: api.SourceTypeInline, TargetNamespace: app.Namespace, Inline: &api.InlineSourceSpec{ConfigMapRef: "bundle", Artifact: artifactTestSpec()}}
	}
	target.Spec.SyncPolicy = api.SyncAuto
	target.Spec.Stages = []api.ApplicationPromotionStage{{Name: "stg"}}
	release.Spec.ManifestSource = &api.ManifestSource{ConfigMapRef: "bundle", Artifact: artifactTestSpec()}
	sourceCM := artifactTestSnapshot(upstream.Namespace, "dev")
	targetCM := artifactTestSnapshot(target.Namespace, "vocus")
	upstream.Spec.Source.Inline.ManifestHash = inlineArtifactPayloadHash([]byte(sourceCM.Data["manifests.yaml"]))
	target.Spec.Source.Inline.ManifestHash = inlineArtifactPayloadHash([]byte(targetCM.Data["manifests.yaml"]))
	release.Annotations[sourceHashAnnotation] = upstream.Spec.Source.Inline.ManifestHash
	return target, upstream, release, sourceCM, targetCM
}

func inlineArtifactReconciler(t *testing.T, objects ...client.Object) *ApplicationReconciler {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, api.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&api.Application{}, &api.Pipeline{}, &api.Release{}).WithObjects(objects...).Build()
	return &ApplicationReconciler{client: c, Scheme: scheme, now: func() time.Time { return promotionTestNow }}
}

func TestInlineArtifactPayloadValidation(t *testing.T) {
	valid := artifactTestPayload("stg", "vocus", artifactTestImage)
	tests := []struct {
		name    string
		payload string
		mutate  func(*api.InlineArtifact)
	}{
		{name: "empty payload", payload: ""},
		{name: "invalid YAML", payload: "[broken"},
		{name: "wrong namespace", payload: strings.Replace(valid, "namespace: stg", "namespace: dev", 1)},
		{name: "mutable primary image", payload: strings.ReplaceAll(valid, artifactTestImage, "ghcr.io/example/api:latest")},
		{name: "substituted primary image", payload: strings.ReplaceAll(valid, artifactTestImage, "ghcr.io/attacker/api@sha256:"+strings.Repeat("b", 64))},
		{name: "primary lacks component label", payload: strings.ReplaceAll(valid, "app.kubernetes.io/component: backend", "app.kubernetes.io/component: other")},
		{name: "primary lacks named container", payload: strings.ReplaceAll(valid, "name: backend", "name: replacement")},
		{name: "job cannot prove deployment image", payload: strings.Replace(valid, "kind: Deployment", "kind: Job", 1)},
		{name: "revision is moving ref", payload: valid, mutate: func(a *api.InlineArtifact) { a.Revision = "main" }},
		{name: "repository includes credentials", payload: valid, mutate: func(a *api.InlineArtifact) { a.Repository = "https://secret@example.test/api" }},
		{name: "declared unqualified ref", payload: valid, mutate: func(a *api.InlineArtifact) {
			a.Images["backend"] = api.ArtifactImageReference("busybox@sha256:" + strings.Repeat("a", 64))
		}},
		{name: "declared mutable ref", payload: valid, mutate: func(a *api.InlineArtifact) { a.Images["backend"] = "ghcr.io/example/api:latest" }},
		{name: "missing component", payload: valid, mutate: func(a *api.InlineArtifact) {
			a.Images["frontend"] = api.ArtifactImageReference("ghcr.io/example/web@sha256:" + strings.Repeat("b", 64))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			artifact := artifactTestSpec()
			if test.mutate != nil {
				test.mutate(artifact)
			}
			require.Error(t, validateInlineArtifactPayload([]byte(test.payload), artifact, "stg"))
		})
	}
	require.NoError(t, validateInlineArtifactPayload([]byte(valid), artifactTestSpec(), "stg"))
	migration := `
---
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec:
  template:
    spec:
      initContainers:
        - name: migrate
          image: ghcr.io/example/api:latest
      containers:
        - name: runner
          image: docker.io/library/busybox:1.37
`
	require.ErrorContains(t, validateInlineArtifactPayload([]byte(valid+migration), artifactTestSpec(), "stg"), "different application image version")
	migration = strings.ReplaceAll(migration, "ghcr.io/example/api:latest", artifactTestImage)
	require.NoError(t, validateInlineArtifactPayload([]byte(valid+migration), artifactTestSpec(), "stg"))
	// A correct migration image cannot disguise a substituted primary API.
	substitution := strings.ReplaceAll(valid, artifactTestImage, "ghcr.io/attacker/api@sha256:"+strings.Repeat("b", 64))
	require.Error(t, validateInlineArtifactPayload([]byte(substitution+migration), artifactTestSpec(), "stg"))
}

func TestInlineArtifactPromotionCreatesOwnSnapshotRelease(t *testing.T) {
	target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
	r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
	_, err := r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	var releases api.ReleaseList
	require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(target.Namespace)))
	require.Len(t, releases.Items, 1)
	created := &releases.Items[0]
	require.Equal(t, targetCM.Name, created.Spec.ManifestSource.ConfigMapRef)
	require.Equal(t, artifactTestSpec(), created.Spec.ManifestSource.Artifact)
	require.Equal(t, promotionTestRevision, created.Annotations[sourceRevisionAnnotation])
	require.Equal(t, string(release.UID), created.Annotations[promotionReleaseUIDAnnotation])
	require.Equal(t, string(upstream.UID), created.Annotations[promotionSourceUIDAnnotation])
	require.NotEmpty(t, target.Status.SourceHash)
	require.Equal(t, promotionTestRevision, target.Status.SourceRevision)
	require.Equal(t, target.Spec.Source, target.Status.AcceptedDeployment.Source)
	var persisted corev1.ConfigMap
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(targetCM), &persisted))
	require.Contains(t, persisted.Data["manifests.yaml"], "value: vocus")
	require.NotContains(t, persisted.Data["manifests.yaml"], "namespace: dev")
}

func TestInlineArtifactPromotionRejectsMismatchedProof(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*api.Application, *api.Application, *api.Release, *corev1.ConfigMap, *corev1.ConfigMap)
	}{
		{"repository", func(target, _ *api.Application, _ *api.Release, _, _ *corev1.ConfigMap) {
			target.Spec.Source.Inline.Artifact.Repository = "https://example.test/other"
		}},
		{"revision", func(target, _ *api.Application, _ *api.Release, _, _ *corev1.ConfigMap) {
			target.Spec.Source.Inline.Artifact.Revision = strings.Repeat("b", 40)
		}},
		{"images", func(target, _ *api.Application, _ *api.Release, _, _ *corev1.ConfigMap) {
			target.Spec.Source.Inline.Artifact.Images["backend"] = api.ArtifactImageReference("ghcr.io/example/api@sha256:" + strings.Repeat("b", 64))
		}},
		{"missing manifest hash", func(target, _ *api.Application, _ *api.Release, _, _ *corev1.ConfigMap) {
			target.Spec.Source.Inline.ManifestHash = ""
		}},
		{"wrong manifest hash", func(target, _ *api.Application, _ *api.Release, _, _ *corev1.ConfigMap) {
			target.Spec.Source.Inline.ManifestHash = strings.Repeat("b", 64)
		}},
		{"mutable source snapshot", func(_, _ *api.Application, _ *api.Release, source, _ *corev1.ConfigMap) {
			source.Immutable = kptr.To(false)
		}},
		{"mutable target snapshot", func(_, _ *api.Application, _ *api.Release, _, target *corev1.ConfigMap) { target.Immutable = nil }},
		{"target payload substitution", func(_, _ *api.Application, _ *api.Release, _, target *corev1.ConfigMap) {
			target.Data["manifests.yaml"] = artifactTestPayload("stg", "vocus", "ghcr.io/attacker/api@sha256:"+strings.Repeat("b", 64))
		}},
		{"source payload substitution", func(_, _ *api.Application, _ *api.Release, source, _ *corev1.ConfigMap) {
			source.Data["manifests.yaml"] = artifactTestPayload("dev", "dev", "ghcr.io/attacker/api@sha256:"+strings.Repeat("b", 64))
		}},
		{"release missing artifact", func(_, _ *api.Application, release *api.Release, _, _ *corev1.ConfigMap) {
			release.Spec.ManifestSource.Artifact = nil
		}},
		{"release wrong snapshot", func(_, _ *api.Application, release *api.Release, _, _ *corev1.ConfigMap) {
			release.Spec.ManifestSource.ConfigMapRef = "old-bundle"
		}},
		{"release wrong revision", func(_, _ *api.Application, release *api.Release, _, _ *corev1.ConfigMap) {
			release.Spec.ManifestSource.Artifact.Revision = strings.Repeat("b", 40)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
			test.mutate(target, upstream, release, sourceCM, targetCM)
			r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
			_, err := r.reconcileApp(context.Background(), target)
			require.NoError(t, err)
			var releases api.ReleaseList
			require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(target.Namespace)))
			require.Empty(t, releases.Items)
			require.Empty(t, target.Status.SourceRevision)
		})
	}
}

func TestInlineArtifactExternalPublisherBindsOnlyMatchingRelease(t *testing.T) {
	_, upstream, release, sourceCM, _ := inlineArtifactFixture()
	r := inlineArtifactReconciler(t, upstream, release, sourceCM)
	require.NoError(t, r.prepareInlineArtifactSource(context.Background(), upstream))
	require.Equal(t, promotionTestRevision, upstream.Status.SourceRevision)
	require.NotEmpty(t, upstream.Status.SourceHash)
	// Publishing a future desired bundle does not relabel the current Release.
	upstream.Spec.Source.Inline.ConfigMapRef = "next-bundle"
	upstream.Spec.Source.Inline.Artifact.Revision = strings.Repeat("b", 40)
	next := sourceCM.DeepCopy()
	next.Name, next.ResourceVersion = "next-bundle", ""
	require.NoError(t, r.client.Create(context.Background(), next))
	require.NoError(t, r.prepareInlineArtifactSource(context.Background(), upstream))
	require.Equal(t, promotionTestRevision, upstream.Status.SourceRevision)
	require.Error(t, promotionSourceCommitReady(upstream, release))
}

func TestInlineArtifactAcceptedIntentRemainsFrozen(t *testing.T) {
	target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
	r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
	_, err := r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	var active api.Release
	require.NoError(t, r.client.Get(context.Background(), types.NamespacedName{Namespace: target.Namespace, Name: target.Status.ReleaseRef}, &active))
	oldHash := target.Status.SourceHash
	// GitOps stages a different tenant configuration and revision. Active drift
	// and recovery must keep the accepted snapshot, not this pending declaration.
	target.Spec.Source.Inline.ConfigMapRef = "next-bundle"
	target.Spec.Source.Inline.Artifact.Revision = strings.Repeat("b", 40)
	target.Spec.Source.TargetNamespace = "different-target"
	require.NoError(t, r.prepareInlineArtifactSource(context.Background(), target))
	require.Equal(t, promotionTestRevision, target.Status.SourceRevision)
	require.Equal(t, oldHash, target.Status.SourceHash)
	frozen := inlineReleaseManifestSource(target)
	require.Equal(t, targetCM.Name, frozen.ConfigMapRef)
	require.Equal(t, promotionTestRevision, frozen.Artifact.Revision)
	payload, err := r.loadInlineManifests(context.Background(), target)
	require.NoError(t, err)
	require.Contains(t, string(payload), "value: vocus")
	require.Equal(t, targetCM.Data["manifests.yaml"], string(payload))
}

func TestInlineArtifactReleaseRejectsInvalidPayloadBeforeApply(t *testing.T) {
	_, upstream, release, sourceCM, _ := inlineArtifactFixture()
	r := inlineArtifactReconciler(t, upstream, release, sourceCM)
	releaseReconciler := NewReleaseReconciler(r.client)
	_, err := releaseReconciler.loadManifestsFromConfigMap(context.Background(), release)
	require.NoError(t, err)
	invalid := release.DeepCopy()
	invalid.Spec.ManifestSource.Artifact.Revision = strings.Repeat("b", 40)
	_, err = releaseReconciler.loadManifestsFromConfigMap(context.Background(), invalid)
	require.ErrorContains(t, err, "matching source revision")
	sourceCM.Data["manifests.yaml"] = artifactTestPayload("dev", "dev", "ghcr.io/attacker/api@sha256:"+strings.Repeat("b", 64))
	require.NoError(t, r.client.Update(context.Background(), sourceCM))
	_, err = releaseReconciler.loadManifestsFromConfigMap(context.Background(), release)
	require.ErrorContains(t, err, "frozen release source hash")
}

func TestInlineArtifactStagedCompatibilityDoesNotLatchIncomingUID(t *testing.T) {
	target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
	target.Spec.Source.Inline.Artifact.Revision = strings.Repeat("b", 40)
	r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
	_, err := r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	require.Nil(t, target.Status.Promotion)
	require.Empty(t, target.Status.ReleaseRef)
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Spec.Source.Inline.Artifact.Revision = promotionTestRevision
	require.NoError(t, r.client.Update(context.Background(), target))
	_, err = r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	require.NotEmpty(t, target.Status.ReleaseRef)
	require.Equal(t, string(release.UID), target.Status.Promotion.SourceReleaseUID)
}

func TestInlineArtifactReplacedSnapshotCannotChangeAcceptedPayload(t *testing.T) {
	target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
	r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
	_, err := r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	// Simulate deleting/recreating the immutable input with the same name but
	// different tenant values and the same images. Frozen payload hashes bind it.
	var snapshot corev1.ConfigMap
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(targetCM), &snapshot))
	require.NoError(t, r.client.Delete(context.Background(), &snapshot))
	snapshot.ResourceVersion, snapshot.UID = "", ""
	snapshot.Data["manifests.yaml"] = artifactTestPayload("stg", "substituted", artifactTestImage)
	require.NoError(t, r.client.Create(context.Background(), &snapshot))
	_, err = r.loadInlineManifests(context.Background(), target)
	require.ErrorContains(t, err, "frozen release source hash")
}

func TestInlineArtifactPendingApprovalRejectsReplacementPayload(t *testing.T) {
	target, upstream, release, sourceCM, targetCM := inlineArtifactFixture()
	target.Spec.SyncPolicy = api.SyncManual
	r := inlineArtifactReconciler(t, target, upstream, release, sourceCM, targetCM)
	_, err := r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	verifiedHash := target.Status.Promotion.VerificationConfigHash
	// Same-name CM replacement must not inherit authorization for the old bytes.
	var snapshot corev1.ConfigMap
	require.NoError(t, r.client.Get(context.Background(), client.ObjectKeyFromObject(targetCM), &snapshot))
	require.NoError(t, r.client.Delete(context.Background(), &snapshot))
	snapshot.ResourceVersion, snapshot.UID = "", ""
	snapshot.Data["manifests.yaml"] = artifactTestPayload(target.Namespace, "substituted", artifactTestImage)
	require.NoError(t, r.client.Create(context.Background(), &snapshot))
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Annotations = map[string]string{promotionApprovalAnnotation: string(release.UID)}
	require.NoError(t, r.client.Update(context.Background(), target))
	_, err = r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	require.Empty(t, target.Status.ReleaseRef)
	require.Nil(t, target.Status.AcceptedDeployment)
	var releases api.ReleaseList
	require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(target.Namespace)))
	require.Empty(t, releases.Items)
	// Explicitly declaring the new payload is a spec edit and consumes the old
	// approval. The same upstream UID must await a new approval for that intent.
	target = getPromotionTestApp(t, r, client.ObjectKeyFromObject(target))
	target.Spec.Source.Inline.ManifestHash = inlineArtifactPayloadHash([]byte(snapshot.Data["manifests.yaml"]))
	require.NoError(t, r.client.Update(context.Background(), target))
	_, err = r.reconcileApp(context.Background(), target)
	require.NoError(t, err)
	require.Equal(t, "AwaitingApproval", target.Status.Promotion.Phase)
	require.NotEqual(t, verifiedHash, target.Status.Promotion.VerificationConfigHash)
	require.Empty(t, target.Annotations[promotionApprovalAnnotation])
	require.Empty(t, target.Status.ReleaseRef)
}

func TestInlineArtifactRejectsCanonicalDuplicateResources(t *testing.T) {
	valid := artifactTestPayload("stg", "vocus", artifactTestImage)
	replacement := strings.ReplaceAll(valid, "app.kubernetes.io/component: backend", "app.kubernetes.io/component: dependency")
	replacement = strings.ReplaceAll(replacement, "name: backend", "name: dependency")
	replacement = strings.ReplaceAll(replacement, artifactTestImage, "ghcr.io/other/dependency@sha256:"+strings.Repeat("b", 64))
	for name, duplicate := range map[string]string{
		"exact identity":             valid,
		"later primary substitution": replacement,
		"default namespace":          strings.ReplaceAll(replacement, "  namespace: stg\n", ""),
		"served version alias":       strings.ReplaceAll(replacement, "apiVersion: apps/v1", "apiVersion: apps/v1beta1"),
	} {
		t.Run(name, func(t *testing.T) {
			require.ErrorContains(t, validateInlineArtifactPayload([]byte(valid+"\n---\n"+duplicate), artifactTestSpec(), "stg"), "duplicate resource identities")
		})
	}
	// Distinct API groups remain different resources even when Kind/name match.
	otherGroup := strings.ReplaceAll(valid, "apiVersion: apps/v1", "apiVersion: example.test/v1")
	require.NoError(t, validateInlineArtifactPayload([]byte(valid+"\n---\n"+otherGroup), artifactTestSpec(), "stg"))
	clusterScoped := "\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: target\n  namespace: ignored-a\n"
	clusterAlias := strings.ReplaceAll(clusterScoped, "ignored-a", "ignored-b")
	require.ErrorContains(t, validateInlineArtifactPayload([]byte(valid+clusterScoped+clusterAlias), artifactTestSpec(), "stg"), "duplicate resource identities")
}
