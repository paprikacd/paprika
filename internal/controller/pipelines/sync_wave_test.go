package pipelines

import (
	"context"
	"errors"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func waveObj(kind, name, wave string) map[string]interface{} {
	obj := map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       kind,
		"metadata":   map[string]interface{}{"name": name},
	}
	if wave != "" {
		obj["metadata"].(map[string]interface{})["annotations"] = map[string]interface{}{ //nolint:forcetypeassert // test fixture
			"paprika.io/sync-wave": wave,
		}
	}
	return obj
}

func waveObjName(t *testing.T, obj map[string]interface{}) string {
	t.Helper()
	name, ok := obj["metadata"].(map[string]interface{})["name"].(string)
	if !ok {
		t.Fatal("fixture object missing metadata.name")
	}
	return name
}

func TestGroupBySyncWave(t *testing.T) {
	t.Parallel()

	t.Run("ascending order, doc order within wave", func(t *testing.T) {
		objs := []map[string]interface{}{
			waveObj("Deployment", "app", "2"),
			waveObj("ConfigMap", "cfg", "-1"),
			waveObj("Service", "svc", "0"),
			waveObj("Deployment", "app2", "2"),
		}
		waves, err := groupBySyncWave(objs)
		if err != nil {
			t.Fatal(err)
		}
		if len(waves) != 3 {
			t.Fatalf("got %d waves, want 3", len(waves))
		}
		if waveObjName(t, waves[0][0]) != "cfg" {
			t.Fatal("wave -1 should come first")
		}
		if len(waves[2]) != 2 || waveObjName(t, waves[2][1]) != "app2" {
			t.Fatal("wave 2 should preserve doc order app,app2")
		}
	})

	t.Run("unannotated defaults to wave 0", func(t *testing.T) {
		waves, err := groupBySyncWave([]map[string]interface{}{waveObj("Deployment", "a", "")})
		if err != nil || len(waves) != 1 {
			t.Fatalf("waves=%v err=%v", waves, err)
		}
	})

	t.Run("argocd compat annotation", func(t *testing.T) {
		obj := waveObj("Deployment", "a", "")
		obj["metadata"].(map[string]interface{})["annotations"] = map[string]interface{}{ //nolint:forcetypeassert // test fixture
			"argocd.argoproj.io/sync-wave": "5",
		}
		waves, err := groupBySyncWave([]map[string]interface{}{obj, waveObj("Service", "b", "1")})
		if err != nil {
			t.Fatal(err)
		}
		if waveObjName(t, waves[0][0]) != "b" {
			t.Fatal("argo wave 5 should sort after wave 1")
		}
	})

	t.Run("malformed wave fails with resource name", func(t *testing.T) {
		_, err := groupBySyncWave([]map[string]interface{}{waveObj("Deployment", "bad", "soon")})
		if err == nil || !containsAll(err.Error(), "soon", "bad") {
			t.Fatalf("expected naming error, got %v", err)
		}
	})
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		found := false
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func waveGateReconciler(t *testing.T, release *paprikav1.Release, live *unstructured.Unstructured) (*ReleaseReconciler, *dynamicfake.FakeDynamicClient) {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := paprikav1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cb := fake.NewClientBuilder().WithScheme(scheme)
	if release != nil {
		cb = cb.WithObjects(release)
	}
	dynScheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(dynScheme); err != nil {
		t.Fatal(err)
	}
	var dyn *dynamicfake.FakeDynamicClient
	if live != nil {
		dyn = dynamicfake.NewSimpleDynamicClient(dynScheme, live)
	} else {
		dyn = dynamicfake.NewSimpleDynamicClient(dynScheme)
	}
	r := NewReleaseReconciler(cb.Build())
	return r, dyn
}

func liveDeployment(name, ns string, ready bool) *unstructured.Unstructured {
	replicas := int64(1)
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]interface{}{"name": name, "namespace": ns},
		"spec":       map[string]interface{}{"replicas": replicas},
	}}
	if ready {
		u.Object["status"] = map[string]interface{}{
			"replicas": replicas, "availableReplicas": replicas, "updatedReplicas": replicas,
		}
	}
	return u
}

func TestGateSyncWave(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	log := logf.Log

	newRelease := func() *paprikav1.Release {
		return &paprikav1.Release{
			ObjectMeta: metav1.ObjectMeta{Name: "rel-1", Namespace: "ns"},
		}
	}

	t.Run("all healthy passes and clears stamp", func(t *testing.T) {
		rel := newRelease()
		rel.SetAnnotations(map[string]string{waveGateStampAnnotation: time.Now().UTC().Format(time.RFC3339)})
		r, dyn := waveGateReconciler(t, rel, liveDeployment("web", "ns", true))
		err := r.gateSyncWave(ctx, log, dyn, []map[string]interface{}{waveObj("Deployment", "web", "0")}, "ns", "rel-1")
		if err != nil {
			t.Fatalf("healthy wave should pass: %v", err)
		}
		var got paprikav1.Release
		if err := r.client.Get(ctx, client.ObjectKey{Name: "rel-1", Namespace: "ns"}, &got); err != nil {
			t.Fatal(err)
		}
		if _, ok := got.GetAnnotations()[waveGateStampAnnotation]; ok {
			t.Fatal("stamp should be cleared after a passing gate")
		}
	})

	t.Run("progressing returns pending sentinel", func(t *testing.T) {
		r, dyn := waveGateReconciler(t, newRelease(), liveDeployment("web", "ns", false))
		err := r.gateSyncWave(ctx, log, dyn, []map[string]interface{}{waveObj("Deployment", "web", "0")}, "ns", "rel-1")
		if !errors.Is(err, errSyncWavePending) {
			t.Fatalf("got %v, want errSyncWavePending", err)
		}
	})

	t.Run("missing resource returns pending", func(t *testing.T) {
		r, dyn := waveGateReconciler(t, newRelease(), nil)
		err := r.gateSyncWave(ctx, log, dyn, []map[string]interface{}{waveObj("Deployment", "web", "0")}, "ns", "rel-1")
		if !errors.Is(err, errSyncWavePending) {
			t.Fatalf("got %v, want errSyncWavePending", err)
		}
	})

	t.Run("expired stamp fails the release", func(t *testing.T) {
		rel := newRelease()
		rel.SetAnnotations(map[string]string{
			waveGateStampAnnotation: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		})
		r, dyn := waveGateReconciler(t, rel, liveDeployment("web", "ns", false))
		err := r.gateSyncWave(ctx, log, dyn, []map[string]interface{}{waveObj("Deployment", "web", "0")}, "ns", "rel-1")
		if err == nil || errors.Is(err, errSyncWavePending) {
			t.Fatalf("stale gate should time out, got %v", err)
		}
	})
}

func TestMatchesAnySelector(t *testing.T) {
	t.Parallel()
	obj := map[string]interface{}{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]interface{}{"name": "web"},
	}
	cases := []struct {
		name string
		sel  syncResourceSelector
		want bool
	}{
		{"kind+name match", syncResourceSelector{Kind: "Deployment", Name: "web"}, true},
		{"kind mismatch", syncResourceSelector{Kind: "Service", Name: "web"}, false},
		{"name mismatch", syncResourceSelector{Kind: "Deployment", Name: "api"}, false},
		{"ns default match", syncResourceSelector{Kind: "Deployment", Name: "web", Namespace: "paprika-e2e"}, true},
		{"ns mismatch", syncResourceSelector{Kind: "Deployment", Name: "web", Namespace: "other"}, false},
		{"group match", syncResourceSelector{Group: "apps", Kind: "Deployment", Name: "web"}, true},
		{"group mismatch", syncResourceSelector{Group: "batch", Kind: "Deployment", Name: "web"}, false},
		{"version match", syncResourceSelector{Group: "apps", Version: "v1", Kind: "Deployment", Name: "web"}, true},
		{"version mismatch", syncResourceSelector{Group: "apps", Version: "v1beta1", Kind: "Deployment", Name: "web"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matchesAnySelector(obj, []syncResourceSelector{tc.sel}, "paprika-e2e"); got != tc.want {
				t.Fatalf("matchesAnySelector = %v, want %v", got, tc.want)
			}
		})
	}
}
