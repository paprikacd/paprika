package main

import (
	"testing"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestMCPSessionStoreRequiresCompleteConfigurationAndExactResource(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects := fake.NewClientBuilder().WithScheme(scheme).WithObjects(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: "paprika", Name: "fleet-sessions"},
		Data:       map[string][]byte{"resource": []byte("https://paprika.example/mcp")},
	}).Build()
	cfg := &cliConfig{MCPPublicURL: "https://paprika.example/", MCPSessionSecret: "fleet-sessions"}
	_, err := newMCPSessionCache(t.Context(), cfg, objects, "/mcp", []byte("test-signing-secret"))
	require.Error(t, err)
	cfg.MCPSessionNamespace = "paprika"
	store, err := newMCPSessionCache(t.Context(), cfg, objects, "/mcp", []byte("test-signing-secret"))
	require.NoError(t, err)
	require.NotNil(t, store)
	_, err = newMCPSessionCache(t.Context(), cfg, objects, "/observe/mcp", []byte("test-signing-secret"))
	require.Error(t, err)
	cfg.MCPSessionSecret = "missing"
	_, err = newMCPSessionCache(t.Context(), cfg, objects, "/mcp", []byte("test-signing-secret"))
	require.Error(t, err)
}
