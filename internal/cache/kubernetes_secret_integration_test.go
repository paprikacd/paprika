package cache

import (
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
)

// Exercise real Kubernetes resource versions and dry-run updates, rather than
// relying exclusively on the fake client's conflict behavior.
func TestSecretCacheRealKubernetesRotation(t *testing.T) {
	assets := os.Getenv("KUBEBUILDER_ASSETS")
	if assets == "" {
		t.Skip("KUBEBUILDER_ASSETS is not configured")
	}
	environment := &envtest.Environment{BinaryAssetsDirectory: assets}
	config, err := environment.Start()
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, environment.Stop()) })
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects, err := client.New(config, client.Options{Scheme: scheme})
	require.NoError(t, err)
	ctx := t.Context()
	require.NoError(t, objects.Create(ctx, &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "oauth-sessions", Namespace: "default"},
		Data:       map[string][]byte{secretResourceKey: []byte(testSessionResource)},
	}))
	first, err := NewKubernetesSecretCache(ctx, objects, "default", "oauth-sessions", testSessionResource, testSessionKey)
	require.NoError(t, err)
	second, err := NewKubernetesSecretCache(ctx, objects, "default", "oauth-sessions", testSessionResource, testSessionKey)
	require.NoError(t, err)
	oldKey := "mcp:refresh:old"
	payload := []byte("stored grant")
	require.NoError(t, first.Set(ctx, oldKey, payload, time.Hour))
	rotator, ok := second.ConditionalReplacer()
	require.True(t, ok)

	const contenders = 12
	start := make(chan struct{})
	results := make(chan bool, contenders)
	errors := make(chan error, contenders)
	var wg sync.WaitGroup
	for i := range contenders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			won, rotateErr := rotator.Replace(ctx, oldKey, payload,
				"mcp:refresh:new-"+strconv.Itoa(i), payload, time.Hour)
			results <- won
			errors <- rotateErr
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	winners := 0
	for won := range results {
		if won {
			winners++
		}
	}
	require.Equal(t, 1, winners)
	got, err := first.Get(ctx, oldKey)
	require.NoError(t, err)
	require.Nil(t, got)
}
