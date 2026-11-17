package cache

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const testSessionResource = "https://paprika.example.test/observe/mcp"

var testSessionKey = []byte("nonsecret-test-signing-key-for-oauth-storage")

func sessionTestClient(t *testing.T) client.Client {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	return fake.NewClientBuilder().WithScheme(scheme).WithObjects(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "sessions", Namespace: "paprika"},
		Data:       map[string][]byte{secretResourceKey: []byte(testSessionResource)},
	}).Build()
}

func sessionTestCache(t *testing.T, objects client.Client) *Cache {
	t.Helper()
	store, err := NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", testSessionResource, testSessionKey)
	require.NoError(t, err)
	return store
}

type noSecretUpdate struct{ client.Client }

func (c noSecretUpdate) Update(context.Context, client.Object, ...client.UpdateOption) error {
	return errors.New("update denied")
}

func TestSecretCacheRequiresUpdatePermissionAtStartup(t *testing.T) {
	objects := sessionTestClient(t)
	_ = sessionTestCache(t, objects) // initialize the encryption canary
	_, err := NewKubernetesSecretCache(t.Context(), noSecretUpdate{objects}, "paprika", "sessions", testSessionResource, testSessionKey)
	require.Error(t, err)
}

func TestSecretCacheSurvivesReplacementWithoutExposingCredentials(t *testing.T) {
	objects := sessionTestClient(t)
	first := sessionTestCache(t, objects)
	key := "mcp:refresh:opaque-bearer-token"
	value := []byte(`{"sub":"private-user","scope":"paprika:observe"}`)
	require.NoError(t, first.Set(t.Context(), key, value, time.Hour))

	var secret corev1.Secret
	require.NoError(t, objects.Get(t.Context(), client.ObjectKey{Namespace: "paprika", Name: "sessions"}, &secret))
	serialized, err := json.Marshal(secret.Data)
	require.NoError(t, err)
	require.False(t, bytes.Contains(serialized, []byte(key)))
	for name, data := range secret.Data {
		require.NotContains(t, name, key)
		require.False(t, bytes.Contains(data, []byte(key)))
		require.False(t, bytes.Contains(data, value))
		require.False(t, bytes.Contains(data, []byte("private-user")))
	}

	second := sessionTestCache(t, objects)
	got, err := second.GetDel(t.Context(), key)
	require.NoError(t, err)
	require.Equal(t, value, got)
	got, err = first.GetDel(t.Context(), key)
	require.NoError(t, err)
	require.Nil(t, got)
}

func TestSecretCacheExpiryAndPrefixDeletion(t *testing.T) {
	objects := sessionTestClient(t)
	store := sessionTestCache(t, objects)
	impl, ok := store.cacheImpl.(*secretCache)
	require.True(t, ok)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	impl.now = func() time.Time { return now }
	require.NoError(t, store.Set(t.Context(), "mcp:refresh:one", []byte("one"), time.Hour))
	require.NoError(t, store.Set(t.Context(), "mcp:refresh:two", []byte("two"), 2*time.Hour))
	require.NoError(t, store.Set(t.Context(), "other", []byte("three"), 2*time.Hour))
	now = now.Add(90 * time.Minute)
	got, err := store.Get(t.Context(), "mcp:refresh:one")
	require.NoError(t, err)
	require.Nil(t, got)
	require.NoError(t, store.DeleteByPrefix(t.Context(), "mcp:refresh:"))
	got, err = store.Get(t.Context(), "mcp:refresh:two")
	require.NoError(t, err)
	require.Nil(t, got)
	got, err = store.Get(t.Context(), "other")
	require.NoError(t, err)
	require.Equal(t, []byte("three"), got)
}

func TestSecretCacheRejectsDifferentResourceKeyAndTampering(t *testing.T) {
	objects := sessionTestClient(t)
	store := sessionTestCache(t, objects)
	_, err := NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", "https://elsewhere.test/mcp", testSessionKey)
	require.Error(t, err)
	_, err = NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", testSessionResource, []byte("different-key"))
	require.Error(t, err)

	require.NoError(t, store.Set(t.Context(), "mcp:refresh:token", []byte("record"), time.Hour))
	var secret corev1.Secret
	require.NoError(t, objects.Get(t.Context(), client.ObjectKey{Namespace: "paprika", Name: "sessions"}, &secret))
	name := secretEntryKey("mcp:refresh:token")
	secret.Data[name][len(secret.Data[name])-1] ^= 1
	require.NoError(t, objects.Update(t.Context(), &secret))
	_, err = store.Get(t.Context(), "mcp:refresh:token")
	require.Error(t, err)
	_, err = store.GetDel(t.Context(), "mcp:refresh:token")
	require.Error(t, err)
}

func TestSecretCacheGetDelIsSingleUseAcrossInstances(t *testing.T) {
	objects := sessionTestClient(t)
	first := sessionTestCache(t, objects)
	second := sessionTestCache(t, objects)
	require.NoError(t, first.Set(t.Context(), "mcp:refresh:concurrent", []byte("grant"), time.Hour))
	const contenders = 16
	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make(chan []byte, contenders)
	errors := make(chan error, contenders)
	for i := range contenders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			store := first
			if i%2 == 0 {
				store = second
			}
			got, err := store.GetDel(context.Background(), "mcp:refresh:concurrent")
			results <- got
			errors <- err
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
	for got := range results {
		if len(got) > 0 {
			winners++
			require.Equal(t, []byte("grant"), got)
		}
	}
	require.Equal(t, 1, winners)
}

func TestSecretCacheRejectsOversizedEntries(t *testing.T) {
	store := sessionTestCache(t, sessionTestClient(t))
	require.Error(t, store.Set(t.Context(), "entry", make([]byte, secretValueLimit+1), time.Minute))
	require.NoError(t, store.Set(t.Context(), "retained", []byte("grant"), time.Hour))
	got, err := store.Get(t.Context(), "retained")
	require.NoError(t, err)
	require.Equal(t, []byte("grant"), got)
	require.Error(t, store.Set(t.Context(), "negative", []byte("grant"), -time.Second))
	impl, ok := store.cacheImpl.(*secretCache)
	require.True(t, ok)
	impl.now = func() time.Time { return time.Unix(0, math.MaxInt64).Add(-time.Second) }
	require.Error(t, store.Set(t.Context(), "overflow", []byte("grant"), 2*time.Second))
}

func TestSecretCacheTemporaryTrafficCannotEvictRefreshGrants(t *testing.T) {
	store := sessionTestCache(t, sessionTestClient(t))
	require.NoError(t, store.Set(t.Context(), "mcp:refresh:retained", []byte("grant"), time.Hour))
	for i := range secretTemporaryEntries {
		require.NoError(t, store.Set(t.Context(), "mcp:pending:"+strconv.Itoa(i), []byte("pending"), time.Hour))
	}
	require.Error(t, store.Set(t.Context(), "mcp:pending:overflow", []byte("pending"), time.Hour))
	got, err := store.Get(t.Context(), "mcp:refresh:retained")
	require.NoError(t, err)
	require.Equal(t, []byte("grant"), got)
	require.NoError(t, store.Set(t.Context(), "mcp:refresh:new", []byte("new grant"), time.Hour))
}
