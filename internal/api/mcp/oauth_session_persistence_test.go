package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/internal/cache"
)

type failingSessionReader struct {
	client.Client
	fail       atomic.Bool
	failUpdate atomic.Bool
}

type transientClientRegistry struct{ unavailable atomic.Bool }

func (r *transientClientRegistry) Register(context.Context, string, []string) error { return nil }
func (r *transientClientRegistry) RedirectURIs(context.Context, string) ([]string, error) {
	if r.unavailable.Load() {
		return nil, errors.New("client registry unavailable")
	}
	return []string{"https://client.example.test/callback"}, nil
}

func (c *failingSessionReader) Get(ctx context.Context, key client.ObjectKey, object client.Object, opts ...client.GetOption) error {
	if c.fail.Load() {
		return errors.New("session storage unavailable")
	}
	return c.Client.Get(ctx, key, object, opts...)
}

func (c *failingSessionReader) Update(ctx context.Context, object client.Object, opts ...client.UpdateOption) error {
	if c.failUpdate.Load() {
		return errors.New("session storage unavailable")
	}
	return c.Client.Update(ctx, object, opts...)
}

func persistentOAuthTestStore(t *testing.T) (*cache.Cache, *failingSessionReader) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects := &failingSessionReader{Client: fake.NewClientBuilder().WithScheme(scheme).WithObjects(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "sessions", Namespace: "paprika"},
		Data:       map[string][]byte{"resource": []byte("https://paprika.example.test/mcp")},
	}).Build()}
	store, err := cache.NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", "https://paprika.example.test/mcp", testSecret)
	require.NoError(t, err)
	return store, objects
}

func issuePersistentTestGrant(t *testing.T, store *cache.Cache) tokenResponse {
	t.Helper()
	srv := newTestServer(t)
	srv.cache = store
	rec := httptest.NewRecorder()
	srv.issueTokenPair(t.Context(), rec, "test", "subject", "user@example.test", "User", "paprika:read", []string{"team"})
	require.Equal(t, http.StatusOK, rec.Code)
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &pair))
	require.NotEmpty(t, pair.RefreshToken)
	return pair
}

func refreshPersistentTestGrant(t *testing.T, store *cache.Cache, token string) *httptest.ResponseRecorder {
	t.Helper()
	srv := newTestServer(t)
	srv.cache = store
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	return postForm(t, mux, "/mcp/token", url.Values{
		"grant_type": {"refresh_token"}, "client_id": {"test"}, "refresh_token": {token},
	})
}

func TestPersistentRefreshSurvivesServerReplacementAndRotates(t *testing.T) {
	first, objects := persistentOAuthTestStore(t)
	pair := issuePersistentTestGrant(t, first)
	second, err := cache.NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", "https://paprika.example.test/mcp", testSecret)
	require.NoError(t, err)
	response := refreshPersistentTestGrant(t, second, pair.RefreshToken)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var next tokenResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &next))
	require.NotEmpty(t, next.RefreshToken)
	require.NotEqual(t, pair.RefreshToken, next.RefreshToken)
	require.Equal(t, http.StatusBadRequest, refreshPersistentTestGrant(t, first, pair.RefreshToken).Code)

	third, err := cache.NewKubernetesSecretCache(t.Context(), objects, "paprika", "sessions", "https://paprika.example.test/mcp", testSecret)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, refreshPersistentTestGrant(t, third, next.RefreshToken).Code)
}

func TestPersistentRefreshStorageOutageIsRetryable(t *testing.T) {
	store, objects := persistentOAuthTestStore(t)
	pair := issuePersistentTestGrant(t, store)
	objects.fail.Store(true)
	response := refreshPersistentTestGrant(t, store, pair.RefreshToken)
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	require.Equal(t, "5", response.Header().Get("Retry-After"))
	require.Contains(t, response.Body.String(), "temporarily_unavailable")
	objects.fail.Store(false)
	require.Equal(t, http.StatusOK, refreshPersistentTestGrant(t, store, pair.RefreshToken).Code)
}

func TestPersistentRefreshWriteFailurePreservesPredecessor(t *testing.T) {
	store, objects := persistentOAuthTestStore(t)
	pair := issuePersistentTestGrant(t, store)
	objects.failUpdate.Store(true)
	response := refreshPersistentTestGrant(t, store, pair.RefreshToken)
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	objects.failUpdate.Store(false)
	require.Equal(t, http.StatusOK, refreshPersistentTestGrant(t, store, pair.RefreshToken).Code)
}

func TestClientRegistryOutageDoesNotInvalidateSavedGrant(t *testing.T) {
	store, _ := persistentOAuthTestStore(t)
	srv := newTestServer(t)
	srv.cache = store
	registry := &transientClientRegistry{}
	srv.clientRegistry = registry
	rec := httptest.NewRecorder()
	srv.issueTokenPair(t.Context(), rec, "dynamic-client", "subject", "", "", "paprika:read", nil)
	require.Equal(t, http.StatusOK, rec.Code)
	var pair tokenResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &pair))
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	form := url.Values{"grant_type": {"refresh_token"}, "client_id": {"dynamic-client"}, "refresh_token": {pair.RefreshToken}}
	registry.unavailable.Store(true)
	response := postForm(t, mux, "/mcp/token", form)
	require.Equal(t, http.StatusServiceUnavailable, response.Code)
	require.Contains(t, response.Body.String(), "temporarily_unavailable")
	registry.unavailable.Store(false)
	require.Equal(t, http.StatusOK, postForm(t, mux, "/mcp/token", form).Code)
}

func TestPersistentConcurrentRefreshHasOneWinner(t *testing.T) {
	store, _ := persistentOAuthTestStore(t)
	pair := issuePersistentTestGrant(t, store)
	srv := newTestServer(t)
	srv.cache = store
	mux := http.NewServeMux()
	srv.RegisterOAuthRoutes(mux)
	const attempts = 16
	start := make(chan struct{})
	statuses := make(chan int, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			response := postForm(t, mux, "/mcp/token", url.Values{
				"grant_type": {"refresh_token"}, "client_id": {"test"}, "refresh_token": {pair.RefreshToken},
			})
			statuses <- response.Code
		}()
	}
	close(start)
	wg.Wait()
	close(statuses)
	winners := 0
	for status := range statuses {
		if status == http.StatusOK {
			winners++
		} else {
			require.Equal(t, http.StatusBadRequest, status)
		}
	}
	require.Equal(t, 1, winners)
}

func TestPersistentSessionExpiry(t *testing.T) {
	store, _ := persistentOAuthTestStore(t)
	require.NoError(t, store.Set(t.Context(), "mcp:refresh:short", []byte("grant"), time.Nanosecond))
	time.Sleep(time.Millisecond)
	got, err := store.GetDel(t.Context(), "mcp:refresh:short")
	require.NoError(t, err)
	require.Nil(t, got)
}
