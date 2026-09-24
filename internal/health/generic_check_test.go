package health

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestCheckGenericCoreKinds(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)

	// The fake client's default RESTMapper resolves nothing; give it the
	// mappings a real cluster's discovery-backed mapper would provide.
	mapper := apimeta.NewDefaultRESTMapper([]schema.GroupVersion{{Group: "", Version: "v1"}})
	for _, gvk := range []schema.GroupVersionKind{
		{Group: "", Version: "v1", Kind: "ConfigMap"},
		{Group: "", Version: "v1", Kind: "ServiceAccount"},
		{Group: "", Version: "v1", Kind: "PersistentVolumeClaim"},
	} {
		mapper.Add(gvk, apimeta.RESTScopeNamespace)
	}

	checker := NewResourceHealthChecker(fake.NewClientBuilder().
		WithScheme(scheme).
		WithRESTMapper(mapper).
		WithObjects(
			&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "cfg", Namespace: "default"}},
			&corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "sa", Namespace: "default"}},
		).Build())

	if h := checker.Check(context.Background(), "ConfigMap", "cfg", "default"); h.Health != "Healthy" {
		t.Fatalf("ConfigMap health = %s (%s), want Healthy", h.Health, h.Message)
	}
	if h := checker.Check(context.Background(), "ConfigMap", "gone", "default"); h.Health != "Missing" {
		t.Fatalf("missing ConfigMap health = %s (%s), want Missing", h.Health, h.Message)
	}
	if h := checker.Check(context.Background(), "ServiceAccount", "sa", "default"); h.Health != "Healthy" {
		t.Fatalf("ServiceAccount health = %s (%s), want Healthy", h.Health, h.Message)
	}
	if h := checker.Check(context.Background(), "PersistentVolumeClaim", "pvc", "default"); h.Health != "Missing" {
		t.Fatalf("missing PVC health = %s (%s), want Missing", h.Health, h.Message)
	}
	if h := checker.Check(context.Background(), "Bogus", "x", "default"); h.Health != "Unknown" {
		t.Fatalf("unmapped kind health = %s (%s), want Unknown", h.Health, h.Message)
	}
}
