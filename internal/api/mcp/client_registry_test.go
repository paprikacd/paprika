package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const registryTestResource = "https://paprika.example/mcp"

func registryFixture(t *testing.T) (client.Client, *KubernetesClientRegistry) {
	t.Helper()
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects := fake.NewClientBuilder().WithScheme(scheme).WithObjects(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Namespace: "paprika", Name: "mcp-clients"},
		Data:       map[string]string{clientRegistryResourceKey: registryTestResource},
	}).Build()
	registry, err := NewKubernetesClientRegistry(t.Context(), objects, "paprika", "mcp-clients", registryTestResource)
	require.NoError(t, err)
	return objects, registry
}

func TestDynamicClientRegistrationSurvivesServerReplacementWithoutGrantingAccess(t *testing.T) {
	objects, firstRegistry := registryFixture(t)
	first := newTestServer(t)
	first.clientRegistry = firstRegistry
	firstMux := http.NewServeMux()
	first.RegisterOAuthRoutes(firstMux)
	const redirect = "https://client.example/oauth/callback"
	registered := postJSON(t, firstMux, "/mcp/register", "", registrationRequest{RedirectURIs: []string{redirect}})
	require.Equal(t, http.StatusCreated, registered.Code)
	var registration map[string]any
	require.NoError(t, json.Unmarshal(registered.Body.Bytes(), &registration))
	id, ok := registration["client_id"].(string)
	require.True(t, ok)

	// A new process has a fresh transient cache and no process-local clients.
	restoredRegistry, err := NewKubernetesClientRegistry(t.Context(), objects, "paprika", "mcp-clients", registryTestResource)
	require.NoError(t, err)
	replacement := newTestServer(t)
	replacement.clientRegistry = restoredRegistry
	require.Empty(t, replacement.dynClients)
	assert.True(t, replacement.clientIDAllowed(t.Context(), id))
	assert.True(t, replacement.isRegisteredRedirect(t.Context(), id, redirect))
	assert.False(t, replacement.isRegisteredRedirect(t.Context(), id, redirect+"/other"))
	assert.False(t, replacement.clientIDAllowed(t.Context(), "unregistered"))

	mux := http.NewServeMux()
	replacement.RegisterOAuthRoutes(mux)
	q := url.Values{"client_id": {id}, "redirect_uri": {redirect}, "response_type": {"code"},
		"code_challenge": {pkceChallengeForFix1}, "code_challenge_method": {"S256"}, "scope": {"paprika:read"}}
	requested := httptest.NewRecorder()
	browserRequest := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/mcp/authorize?"+q.Encode(), nil)
	browserRequest.Header.Set("Accept", "text/html")
	mux.ServeHTTP(requested, browserRequest)
	require.Equal(t, http.StatusFound, requested.Code)
	location, err := url.Parse(requested.Header().Get("Location"))
	require.NoError(t, err)
	pendingPath := "/mcp/authorize/pending?rid=" + url.QueryEscape(location.Query().Get("rid"))
	unauthenticated := httptest.NewRecorder()
	mux.ServeHTTP(unauthenticated, httptest.NewRequestWithContext(t.Context(), http.MethodGet, pendingPath, nil))
	assert.Equal(t, http.StatusUnauthorized, unauthenticated.Code, "registration alone grants no authority")
	resolved := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, pendingPath, nil)
	req.Header.Set("Authorization", "Bearer "+consoleBearerFor(t, "test-user"))
	mux.ServeHTTP(resolved, req)
	require.Equal(t, http.StatusOK, resolved.Code, "a new authenticated request must resolve the original host registration")

	var cm corev1.ConfigMap
	require.NoError(t, objects.Get(t.Context(), client.ObjectKey{Namespace: "paprika", Name: "mcp-clients"}, &cm))
	for key, value := range cm.Data {
		assert.NotContains(t, value, pkceChallengeForFix1)
		assert.True(t, key == "resource" || strings.HasPrefix(key, "client."))
	}
}

func TestKubernetesClientRegistryRejectsReplacementAndPreservesExactRedirects(t *testing.T) {
	_, registry := registryFixture(t)
	ctx := t.Context()
	require.NoError(t, registry.Register(ctx, "client-a", []string{"https://client.example/callback"}))
	require.Error(t, registry.Register(ctx, "client-a", []string{"https://attacker.example/callback"}))
	redirects, err := registry.RedirectURIs(ctx, "client-a")
	require.NoError(t, err)
	assert.Equal(t, []string{"https://client.example/callback"}, redirects)
}

func TestKubernetesClientRegistryFailsClosedForMissingOrDifferentSurface(t *testing.T) {
	objects, _ := registryFixture(t)
	_, err := NewKubernetesClientRegistry(t.Context(), objects, "paprika", "missing", registryTestResource)
	require.Error(t, err)
	_, err = NewKubernetesClientRegistry(t.Context(), objects, "paprika", "mcp-clients", "https://paprika.example/observe/mcp")
	require.Error(t, err, "a fleet registry must not become an observe registry")
}

func TestKubernetesClientRegistryCapacityNeverEvictsExistingClients(t *testing.T) {
	for _, mode := range []string{"count", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			objects, registry := registryFixture(t)
			var cm corev1.ConfigMap
			require.NoError(t, objects.Get(t.Context(), registry.key, &cm))
			if mode == "count" {
				for i := range dynClientCap {
					cm.Data[fmt.Sprintf("client.existing-%d", i)] = `["https://client.example/callback"]`
				}
			} else {
				cm.Data["client.existing"] = strings.Repeat(" ", clientRegistryMaxBytes)
			}
			require.NoError(t, objects.Update(t.Context(), &cm))
			before := cm.DeepCopy()
			require.ErrorIs(t, registry.Register(t.Context(), "new-client", []string{"https://client.example/callback"}), errClientRegistryFull)
			require.NoError(t, objects.Get(t.Context(), registry.key, &cm))
			assert.Equal(t, before.Data, cm.Data)
		})
	}
}

type concurrentRegistryUpdate struct {
	clientRegistryObjects
	conflicted bool
}

func (c *concurrentRegistryUpdate) Update(ctx context.Context, object client.Object, opts ...client.UpdateOption) error {
	if !c.conflicted {
		c.conflicted = true
		var current corev1.ConfigMap
		if err := c.Get(ctx, client.ObjectKeyFromObject(object), &current); err != nil {
			return err
		}
		current.Data["client.other-process"] = `["https://other.example/callback"]`
		if err := c.clientRegistryObjects.Update(ctx, &current); err != nil {
			return err
		}
		return apierrors.NewConflict(schema.GroupResource{Resource: "configmaps"}, object.GetName(), errors.New("synthetic concurrent registration"))
	}
	return c.clientRegistryObjects.Update(ctx, object, opts...)
}

func TestKubernetesClientRegistryRetriesConflictsWithoutLosingAnotherRegistration(t *testing.T) {
	objects, _ := registryFixture(t)
	conflicting := &concurrentRegistryUpdate{clientRegistryObjects: objects}
	registry, err := NewKubernetesClientRegistry(t.Context(), conflicting, "paprika", "mcp-clients", registryTestResource)
	require.NoError(t, err)
	require.NoError(t, registry.Register(t.Context(), "this-process", []string{"https://this.example/callback"}))
	for _, id := range []string{"other-process", "this-process"} {
		redirects, lookupErr := registry.RedirectURIs(t.Context(), id)
		require.NoError(t, lookupErr)
		require.Len(t, redirects, 1)
	}
}
