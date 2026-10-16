package pipelines

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kptr "k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/yaml"

	api "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/engine"
)

func inlineDeployedRevisionFixture() (*api.Application, *api.Application, *api.Release, *corev1.ConfigMap, *corev1.ConfigMap) {
	target, source, release, sourceCM, targetCM := inlineArtifactFixture()
	source.Status.SourceHash = source.Spec.Source.Inline.ManifestHash
	source.Status.SourceRevision = promotionTestRevision
	source.Status.Revision = ""
	return target, source, release, sourceCM, targetCM
}

// Existing Healthy Applications skip handleActiveRelease, unlike a newly
// deployed Application. Exercise the actual steady-state diff/health/status
// path without fabricating the legacy deployed Revision it must repair.
func TestInlineArtifactHealthyExternalPublisherConvergesDeployedRevision(t *testing.T) {
	for _, legacyRevision := range []string{"", strings.Repeat("b", 40)} {
		t.Run("legacy_revision_"+legacyRevision, func(t *testing.T) {
			target, source, release, sourceCM, targetCM := inlineDeployedRevisionFixture()
			source.Status.Revision = legacyRevision
			source.Status.DeploymentObservation = nil
			source.Status.Resources, source.Status.ResourceHealth = nil, nil
			r := inlineArtifactReconciler(t, source, release, sourceCM, target, targetCM)
			live := healthyInlineRevisionWorkload(t, sourceCM, source.Name)
			dynamicClient := dynamicfake.NewSimpleDynamicClient(r.Scheme, &live)
			diff := engine.NewScalableDiffEngine(dynamicClient)
			diff.SetLiveCache(nil)
			r.DiffEngine = diff

			// Source convergence alone cannot claim that a revision deployed.
			require.NoError(t, r.prepareInlineArtifactSource(context.Background(), source))
			require.Equal(t, legacyRevision, source.Status.Revision)
			require.Error(t, promotionSourceCommitReady(source, release))

			_, err := r.evaluateHealthyApplication(context.Background(), source, time.Second)
			require.NoError(t, err)
			persisted := getPromotionTestApp(t, r, client.ObjectKeyFromObject(source))
			require.Equal(t, promotionTestRevision, persisted.Status.Revision)
			require.Equal(t, source.UID, persisted.UID)
			require.Equal(t, source.Generation, persisted.Generation)
			require.Equal(t, release.Name, persisted.Status.ReleaseRef)
			require.Equal(t, string(release.UID), persisted.Status.DeploymentObservation.ReleaseUID)
			require.NoError(t, promotionSourceReady(persisted, release, promotionTestNow))

			// The repaired source admits the same owned Release into the next
			// environment; it does not create a new source rollout or identity.
			result, err := r.reconcilePromotionTrigger(context.Background(), target)
			require.NoError(t, err)
			require.Nil(t, result)
			require.Equal(t, "Ready", target.Status.Promotion.Phase)
			require.Equal(t, string(source.UID), target.Status.Promotion.SourceApplicationUID)
			require.Equal(t, string(release.UID), target.Status.Promotion.SourceReleaseUID)
			var releases api.ReleaseList
			require.NoError(t, r.client.List(context.Background(), &releases, client.InNamespace(source.Namespace)))
			require.Len(t, releases.Items, 1)
			require.Equal(t, release.UID, releases.Items[0].UID)
			require.Equal(t, release.Spec, releases.Items[0].Spec)
			for _, action := range dynamicClient.Actions() {
				require.Contains(t, []string{"get", "list"}, action.GetVerb(), "revision recovery must not roll out workloads")
			}
		})
	}
}

func healthyInlineRevisionWorkload(t *testing.T, cm *corev1.ConfigMap, application string) unstructured.Unstructured {
	t.Helper()
	var live unstructured.Unstructured
	require.NoError(t, yaml.Unmarshal([]byte(cm.Data["manifests.yaml"]), &live.Object))
	live.SetUID(types.UID("workload-uid"))
	live.SetGeneration(1)
	labels := live.GetLabels()
	labels[engine.ManagedByLabelKey], labels[engine.ApplicationNameLabelKey] = engine.ManagedByLabelValue, application
	live.SetLabels(labels)
	require.NoError(t, unstructured.SetNestedField(live.Object, int64(1), "spec", "replicas"))
	live.Object["status"] = map[string]any{"observedGeneration": int64(1), "replicas": int64(1), "readyReplicas": int64(1), "availableReplicas": int64(1), "updatedReplicas": int64(1)}
	return live
}

func TestInlineArtifactDeployedRevisionRequiresCurrentDeploymentEvidence(t *testing.T) {
	tests := []struct {
		name          string
		mutate        func(*api.Application, *api.Release, *corev1.ConfigMap)
		snapshotError bool
	}{
		{"application generation stale", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Generation++ }, false},
		{"application not healthy", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.Phase = api.ApplicationPromoting
		}, false},
		{"source not synced", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Status.Synced = false }, false},
		{"source revision mismatch", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.SourceRevision = strings.Repeat("b", 40)
		}, false},
		{"source hash mismatch", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.SourceHash = strings.Repeat("b", 64)
		}, false},
		{"release incomplete", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) { r.Status.Phase = api.ReleasePending }, false},
		{"release generation stale", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) { r.Generation++ }, false},
		{"release owner mismatch", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) {
			r.OwnerReferences[0].UID = "other-application"
		}, false},
		{"release missing UID", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) { r.UID = "" }, false},
		{"release hash mismatch", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) {
			r.Annotations[sourceHashAnnotation] = strings.Repeat("b", 64)
		}, false},
		{"release artifact mismatch", func(_ *api.Application, r *api.Release, _ *corev1.ConfigMap) {
			r.Spec.ManifestSource.Artifact.Revision = strings.Repeat("b", 40)
		}, false},
		{"desired artifact advanced", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Spec.Source.Inline.Artifact.Revision = strings.Repeat("b", 40)
		}, false},
		{"desired snapshot changed", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Spec.Source.Inline.ConfigMapRef = "future-bundle"
		}, false},
		{"diff unavailable", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { markApplicationDiffUnavailable(a) }, false},
		{"drift", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Status.OutOfSync = 1 }, false},
		{"resource unhealthy", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.ResourceHealth[0].Health = "Degraded"
		}, false},
		{"resource health missing", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Status.ResourceHealth = nil }, false},
		{"resource not synced", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.Resources[0].Status = "OutOfSync"
		}, false},
		{"observation missing", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) { a.Status.DeploymentObservation = nil }, false},
		{"observation release UID mismatch", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.DeploymentObservation.ReleaseUID = "old-release"
		}, false},
		{"observation revision mismatch", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.DeploymentObservation.Revision = strings.Repeat("b", 40)
		}, false},
		{"observation generation stale", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.DeploymentObservation.ObservedGeneration = 0
		}, false},
		{"observation stale", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(-3 * time.Minute))
		}, false},
		{"observation future", func(a *api.Application, _ *api.Release, _ *corev1.ConfigMap) {
			a.Status.DeploymentObservation.ObservedAt = metav1.NewTime(promotionTestNow.Add(time.Second))
		}, false},
		{"snapshot mutable", func(_ *api.Application, _ *api.Release, cm *corev1.ConfigMap) { cm.Immutable = kptr.To(false) }, true},
		{"snapshot replaced bytes", func(_ *api.Application, _ *api.Release, cm *corev1.ConfigMap) {
			cm.Data["manifests.yaml"] += "\n# substituted\n"
		}, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, source, release, sourceCM, _ := inlineDeployedRevisionFixture()
			source.Status.Revision = "legacy-deployed-revision"
			test.mutate(source, release, sourceCM)
			r := inlineArtifactReconciler(t, source, release, sourceCM)
			err := r.convergeInlineDeployedRevision(context.Background(), source)
			if test.snapshotError {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, "legacy-deployed-revision", source.Status.Revision)
			require.Equal(t, "legacy-deployed-revision", getPromotionTestApp(t, r, client.ObjectKeyFromObject(source)).Status.Revision)
		})
	}
}

func TestInlineArtifactSourceBindingDoesNotRelabelPendingDeployment(t *testing.T) {
	_, source, release, sourceCM, _ := inlineDeployedRevisionFixture()
	source.Status.SourceHash, source.Status.SourceRevision = "", ""
	source.Status.Revision = "previous-deployment"
	release.Status.Phase = api.ReleasePending
	r := inlineArtifactReconciler(t, source, release, sourceCM)
	require.NoError(t, r.prepareInlineArtifactSource(context.Background(), source))
	require.Equal(t, promotionTestRevision, source.Status.SourceRevision)
	require.NoError(t, r.convergeInlineDeployedRevision(context.Background(), source))
	require.Equal(t, "previous-deployment", source.Status.Revision)
	require.Error(t, promotionSourceCommitReady(source, release))
}

func TestInlineArtifactDeployedRevisionConvergenceLeavesGitGuardUnchanged(t *testing.T) {
	_, source, release := promotionFixture()
	source.Status.Revision = "old-git-commit"
	r := newPromotionTestReconciler(t, source, release)
	require.NoError(t, r.convergeInlineDeployedRevision(context.Background(), source))
	require.Equal(t, "old-git-commit", source.Status.Revision)
	require.Error(t, promotionSourceCommitReady(source, release))
}
