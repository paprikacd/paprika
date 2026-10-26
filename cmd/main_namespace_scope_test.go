package main

import (
	"io"
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// Match the namespaced kinds and list mappings returned by Kubernetes
// discovery. The generic fake client otherwise has an empty REST mapper.
func namespaceTestMapper() meta.RESTMapper {
	mapper := meta.NewDefaultRESTMapper([]schema.GroupVersion{corev1.SchemeGroupVersion, observabilityv1alpha1.GroupVersion})
	for _, kind := range []string{"ConfigMap", "ConfigMapList"} {
		mapper.Add(corev1.SchemeGroupVersion.WithKind(kind), meta.RESTScopeNamespace)
	}
	for _, kind := range []string{"ObservabilityProvider", "ObservabilityProviderList"} {
		mapper.Add(observabilityv1alpha1.GroupVersion.WithKind(kind), meta.RESTScopeNamespace)
	}
	return mapper
}

func TestAPINamespaceValidation(t *testing.T) {
	cfg, err := parseManagerConfig([]string{"--api-namespace=review-samples"}, io.Discard)
	require.NoError(t, err)
	require.Equal(t, "review-samples", cfg.APINamespace)
	for _, namespace := range []string{"", "review-samples", "tenant-42"} {
		require.NoError(t, validateAPINamespace(namespace))
	}
	for _, namespace := range []string{"*", "review,production", "../production", "Review", " review "} {
		require.Error(t, validateAPINamespace(namespace))
	}
	require.Nil(t, apiCacheNamespaceOptions(""), "existing deployments retain their configured cache scope")
	require.Len(t, apiCacheNamespaceOptions("review-samples"), 1)
	require.Contains(t, apiCacheNamespaceOptions("review-samples"), "review-samples")
}

func TestScopedAPIClientCannotReadOrChangeAnotherNamespace(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects := fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(namespaceTestMapper()).WithObjects(
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "review-samples", Name: "sample"}},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "production", Name: "private"}},
	).Build()
	scoped := namespaceScopedAPIClient(objects, "review-samples")
	var list corev1.ConfigMapList
	require.NoError(t, scoped.List(t.Context(), &list))
	require.Len(t, list.Items, 1)
	require.Equal(t, "sample", list.Items[0].Name)
	require.Error(t, scoped.List(t.Context(), &list, client.InNamespace("production")))
	require.Error(t, scoped.Get(t.Context(), client.ObjectKey{Namespace: "production", Name: "private"}, &corev1.ConfigMap{}))
	require.Error(t, scoped.Create(t.Context(), &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "production", Name: "new"}}))
	require.Error(t, scoped.Delete(t.Context(), &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "production", Name: "private"}}))
	require.Error(t, scoped.DeleteAllOf(t.Context(), &corev1.ConfigMap{}, client.InNamespace("production")))
	require.NoError(t, scoped.Get(t.Context(), client.ObjectKey{Name: "sample"}, &corev1.ConfigMap{}))
	var all corev1.ConfigMapList
	require.NoError(t, namespaceScopedAPIClient(objects, "").List(t.Context(), &all))
	require.Len(t, all.Items, 2, "the default does not change existing cluster-wide API instances")
}

func TestScopedObservabilityInventoryExcludesProductionEvenWithBroadHumanRules(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, observabilityv1alpha1.AddToScheme(scheme))
	objects := fake.NewClientBuilder().WithScheme(scheme).WithRESTMapper(namespaceTestMapper()).WithObjects(
		&observabilityv1alpha1.ObservabilityProvider{ObjectMeta: metav1.ObjectMeta{Namespace: "review-samples", Name: "mock"}},
		&observabilityv1alpha1.ObservabilityProvider{ObjectMeta: metav1.ObjectMeta{Namespace: "production", Name: "private"}},
	).Build()
	backend := observabilitygateway.NewAuthorizedBackend(namespaceScopedAPIClient(objects, "review-samples"), auth.NewRBACAuthorizer([]auth.RBACRule{
		{Subjects: []string{"reviewer"}, Actions: []string{"read"}, Resources: []string{"*"}, Namespaces: []string{"*"}},
	}))
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "reviewer"})
	providers, err := backend.ListProviders(ctx)
	require.NoError(t, err)
	require.Len(t, providers, 1)
	require.Equal(t, "review-samples/mock", providers[0].Name)
}
