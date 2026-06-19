package core

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
)

func TestRepositoryReconciler_Reconcile(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))

	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{
			Name:       "repo",
			Namespace:  "default",
			Generation: 1,
		},
		Spec: corev1alpha1.RepositorySpec{
			Type: corev1alpha1.RepositoryTypeOCI,
			URL:  "oci://registry.example.com/charts",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(repo).WithStatusSubresource(repo).Build()
	r := &RepositoryReconciler{client: c, Scheme: scheme}

	res, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "repo", Namespace: "default"}})
	require.NoError(t, err)
	assert.Equal(t, repositoryHealthCheckInterval, res.RequeueAfter)

	var updated corev1alpha1.Repository
	require.NoError(t, c.Get(context.Background(), types.NamespacedName{Name: "repo", Namespace: "default"}, &updated))
	assert.NotNil(t, updated.Status.ConnectionState)
	assert.Equal(t, int64(1), updated.Status.ObservedGeneration)
	assert.Equal(t, corev1alpha1.ConnectionStatusUnknown, updated.Status.ConnectionState.Status)
}

func TestRepositoryReconciler_Reconcile_notFound(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))

	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	r := &RepositoryReconciler{client: c, Scheme: scheme}

	_, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "repo", Namespace: "default"}})
	require.NoError(t, err)
}

func TestConnectionStateEqual(t *testing.T) {
	t.Parallel()

	success := &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusSuccessful, Message: "ok"}
	success2 := &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusSuccessful, Message: "ok"}
	failed := &corev1alpha1.ConnectionState{Status: corev1alpha1.ConnectionStatusFailed, Message: "err"}

	assert.True(t, connectionStateEqual(success, success2))
	assert.False(t, connectionStateEqual(success, failed))
	assert.False(t, connectionStateEqual(success, nil))
	assert.True(t, connectionStateEqual(nil, nil))
}

func TestTrimSlash(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "foo", trimSlash("foo/"))
	assert.Equal(t, "foo", trimSlash("foo"))
	assert.Equal(t, "", trimSlash(""))
}

func TestLoadBasicAuth(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "creds", Namespace: "default"},
		Data: map[string][]byte{
			"username": []byte("user"),
			"password": []byte("pass"),
		},
	}
	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "repo", Namespace: "default"},
		Spec: corev1alpha1.RepositorySpec{
			SecretRef: &corev1alpha1.SecretRef{Name: "creds"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret, repo).Build()
	r := &RepositoryReconciler{client: c}

	username, password, err := r.loadBasicAuth(context.Background(), repo)
	require.NoError(t, err)
	assert.Equal(t, "user", username)
	assert.Equal(t, "pass", password)
}

func TestLoadBasicAuth_secretNotFound(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))

	repo := &corev1alpha1.Repository{
		ObjectMeta: metav1.ObjectMeta{Name: "repo", Namespace: "default"},
		Spec: corev1alpha1.RepositorySpec{
			SecretRef: &corev1alpha1.SecretRef{Name: "missing"},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(repo).Build()
	r := &RepositoryReconciler{client: c}

	_, _, err := r.loadBasicAuth(context.Background(), repo)
	require.Error(t, err)
}
