package hooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func testObj(kind, name, ns string, annotations map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: kind})
	u.SetName(name)
	u.SetNamespace(ns)
	if annotations != nil {
		u.SetAnnotations(annotations)
	}
	return u
}

func TestClassifyPaired_NoHooks_AllInSync(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "regular-job", "default", nil), Raw: []byte("kind: Job")},
		{Obj: testObj("ConfigMap", "regular-cm", "default", nil), Raw: []byte("kind: ConfigMap")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 2)
	assert.Empty(t, bucket.PreSync)
	assert.Empty(t, bucket.PostSync)
	assert.Empty(t, bucket.SyncFail)
}

func TestClassifyPaired_PreSyncHook_NotInSync(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "presync-job", "default", map[string]string{paprikav1.HookAnnotation: "PreSync"}), Raw: []byte("kind: Job")},
		{Obj: testObj("Deployment", "app", "default", nil), Raw: []byte("kind: Deployment")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.True(t, bucket.HasHooks())
	assert.Len(t, bucket.PreSync, 1)
	assert.Len(t, bucket.Sync, 1)
	assert.Equal(t, "presync-job", bucket.PreSync[0].Obj.GetName())
	assert.Equal(t, PhasePreSync, bucket.PreSync[0].Phase)
}

func TestClassifyPaired_MultiPhaseAnnotation_AppearsInBoth(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "multi", "default", map[string]string{paprikav1.HookAnnotation: "PreSync,PostSync"}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.Len(t, bucket.PreSync, 1)
	assert.Len(t, bucket.PostSync, 1)
	assert.Empty(t, bucket.Sync, "multi-phase hook must NOT also be in Sync")
}

func TestClassifyPaired_SyncFailOnly(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "cleanup", "default", map[string]string{paprikav1.HookAnnotation: "SyncFail"}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.Len(t, bucket.SyncFail, 1)
	assert.Empty(t, bucket.Sync)
}

func TestClassifyPaired_UnknownPhaseValue_TreatedAsNonHook(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "weird", "default", map[string]string{paprikav1.HookAnnotation: "Garbage"}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1, "unknown phase value falls back to Sync")
}

func TestClassifyPaired_ExplicitSyncAnnotation_TreatedAsNonHook(t *testing.T) {
	// MVP divergence from ArgoCD: hook=Sync is treated as a non-hook.
	paired := []PairedObj{
		{Obj: testObj("Job", "explicit-sync", "default", map[string]string{paprikav1.HookAnnotation: "Sync"}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1)
}

func TestClassifyPaired_EmptyAnnotationValue_TreatedAsNonHook(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "empty", "default", map[string]string{paprikav1.HookAnnotation: ""}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1)
}

func TestClassifyPaired_DeletePolicyCaptured(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "presync", "default", map[string]string{
			paprikav1.HookAnnotation:             "PreSync",
			paprikav1.HookDeletePolicyAnnotation: "HookSucceeded",
		}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.Equal(t, "HookSucceeded", bucket.PreSync[0].DeletePolicy)
}

func TestPairWithBytes(t *testing.T) {
	raw := []byte("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n")
	objs := []*unstructured.Unstructured{
		testObj("ConfigMap", "a", "default", nil),
		testObj("ConfigMap", "b", "default", nil),
	}
	paired, err := PairWithBytes(objs, raw)
	require.NoError(t, err)
	assert.Len(t, paired, 2)
	assert.Contains(t, string(paired[0].Raw), "name: a")
	assert.Contains(t, string(paired[1].Raw), "name: b")
}

func TestPairWithBytes_MismatchedLengths(t *testing.T) {
	raw := []byte("kind: A\n---\nkind: B\n---\nkind: C\n")
	objs := []*unstructured.Unstructured{testObj("ConfigMap", "a", "default", nil)}
	_, err := PairWithBytes(objs, raw)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "1 objects but 3 raw docs")
}

func TestSyncDocs_PreservesNonHookBytes(t *testing.T) {
	raw := []byte("apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: presync\n  annotations:\n    argocd.argoproj.io/hook: PreSync\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: regular\n")
	objs := []*unstructured.Unstructured{
		testObj("Job", "presync", "default", map[string]string{paprikav1.HookAnnotation: "PreSync"}),
		testObj("ConfigMap", "regular", "default", nil),
	}
	paired, err := PairWithBytes(objs, raw)
	require.NoError(t, err)
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	syncBytes := bucket.SyncDocs()
	assert.Contains(t, string(syncBytes), "kind: ConfigMap")
	assert.NotContains(t, string(syncBytes), "name: presync")
}

func TestSyncDocs_EmptyWhenAllHooks(t *testing.T) {
	paired := []PairedObj{
		{Obj: testObj("Job", "presync", "default", map[string]string{paprikav1.HookAnnotation: "PreSync"}), Raw: []byte("kind: Job")},
	}
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	assert.Empty(t, bucket.SyncDocs())
}
