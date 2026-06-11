package controller

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func createTestScheme() *runtime.Scheme {
	s := scheme.Scheme
	_ = corev1.AddToScheme(s)
	return s
}

func TestClusterConnectionPool_GetClient_DefaultCluster(t *testing.T) {
	scheme := createTestScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	defaultConfig := &rest.Config{Host: "https://default.cluster"}

	pool := NewClusterConnectionPool(c, defaultConfig)
	pool.ttl = time.Hour

	client1, err := pool.GetClient(context.Background(), "", "default")
	require.NoError(t, err)
	assert.NotNil(t, client1)

	// Second call should return cached client
	client2, err := pool.GetClient(context.Background(), "", "default")
	require.NoError(t, err)
	assert.Equal(t, client1, client2, "should return cached default client")
}

func TestClusterConnectionPool_GetClient_CachesByKubeconfigHash(t *testing.T) {
	scheme := createTestScheme()
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "test-kc", Namespace: "default"},
		Data:       map[string][]byte{"kubeconfig": []byte(testKubeconfig)},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret).Build()
	defaultConfig := &rest.Config{Host: "https://default.cluster"}

	pool := NewClusterConnectionPool(c, defaultConfig)
	pool.ttl = time.Hour

	client1, err := pool.GetClient(context.Background(), "test-kc", "default")
	require.NoError(t, err)
	assert.NotNil(t, client1)

	// Second call with same secret should return cached client
	client2, err := pool.GetClient(context.Background(), "test-kc", "default")
	require.NoError(t, err)
	assert.Equal(t, client1, client2, "should return cached client for same kubeconfig")
}

func TestClusterConnectionPool_GetClient_DifferentSecrets(t *testing.T) {
	scheme := createTestScheme()
	secret1 := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "kc-1", Namespace: "default"},
		Data:       map[string][]byte{"kubeconfig": []byte(testKubeconfigForCluster("cluster1"))},
	}
	secret2 := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "kc-2", Namespace: "default"},
		Data:       map[string][]byte{"kubeconfig": []byte(testKubeconfigForCluster("cluster2"))},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret1, secret2).Build()
	defaultConfig := &rest.Config{Host: "https://default.cluster"}

	pool := NewClusterConnectionPool(c, defaultConfig)
	pool.ttl = time.Hour

	client1, err := pool.GetClient(context.Background(), "kc-1", "default")
	require.NoError(t, err)

	client2, err := pool.GetClient(context.Background(), "kc-2", "default")
	require.NoError(t, err)

	assert.NotEqual(t, client1, client2, "different secrets should produce different clients")
}

func TestClusterConnectionPool_GetClient_MissingKubeconfigKey(t *testing.T) {
	scheme := createTestScheme()
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "bad-kc", Namespace: "default"},
		Data:       map[string][]byte{"wrong-key": []byte("data")},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(secret).Build()
	defaultConfig := &rest.Config{Host: "https://default.cluster"}

	pool := NewClusterConnectionPool(c, defaultConfig)

	_, err := pool.GetClient(context.Background(), "bad-kc", "default")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "kubeconfig secret missing")
}

func TestClusterConnectionPool_GetRestConfig_Default(t *testing.T) {
	scheme := createTestScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	defaultConfig := &rest.Config{Host: "https://default.cluster"}

	pool := NewClusterConnectionPool(c, defaultConfig)

	cfg, err := pool.GetRestConfig(context.Background(), "", "default")
	require.NoError(t, err)
	assert.Equal(t, defaultConfig, cfg)
}

func TestClusterConnectionPool_isValid(t *testing.T) {
	pool := &ClusterConnectionPool{ttl: time.Minute}

	// Valid client
	pc := &pooledClient{
		lastUsed: time.Now(),
		healthy:  true,
	}
	assert.True(t, pool.isValid(pc))

	// Expired client
	pc.lastUsed = time.Now().Add(-2 * time.Minute)
	assert.False(t, pool.isValid(pc))

	// Circuit breaker open
	pc.lastUsed = time.Now()
	pc.circuitOpen = true
	pc.circuitOpenAt = time.Now()
	assert.False(t, pool.isValid(pc))

	// Circuit breaker expired
	pc.circuitOpenAt = time.Now().Add(-3 * time.Minute)
	assert.True(t, pool.isValid(pc))

	// Unhealthy
	pc.circuitOpen = false
	pc.healthy = false
	assert.False(t, pool.isValid(pc))

	// Nil
	assert.False(t, pool.isValid(nil))
}

func TestClusterConnectionPool_evictExpired(t *testing.T) {
	scheme := createTestScheme()
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	pool := NewClusterConnectionPool(c, &rest.Config{})
	pool.ttl = time.Minute

	// Add clients
	pool.clients["default"] = &pooledClient{lastUsed: time.Now()}
	pool.clients["expired"] = &pooledClient{lastUsed: time.Now().Add(-10 * time.Minute)}
	pool.clients["fresh"] = &pooledClient{lastUsed: time.Now()}

	pool.evictExpired()

	assert.Contains(t, pool.clients, "default")
	assert.Contains(t, pool.clients, "fresh")
	assert.NotContains(t, pool.clients, "expired")
}

func testKubeconfigForCluster(name string) string {
	return `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://` + name + `.cluster
  name: ` + name + `
contexts:
- context:
    cluster: ` + name + `
    user: ` + name + `
  name: ` + name + `
current-context: ` + name + `
users:
- name: ` + name + `
  user:
    token: test-token-` + name + `
`
}

const testKubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://test.cluster
  name: test
contexts:
- context:
    cluster: test
    user: test
  name: test
current-context: test
users:
- name: test
  user:
    token: test-token
`
