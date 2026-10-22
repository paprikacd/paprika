package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func TestMCPClientRegistryRequiresCompleteConfigurationAndExactSurface(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, corev1.AddToScheme(scheme))
	objects := fake.NewClientBuilder().WithScheme(scheme).WithObjects(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Namespace: "paprika", Name: "fleet-clients"},
		Data:       map[string]string{"resource": "https://paprika.example/mcp"},
	}).Build()
	cfg := &cliConfig{MCPPublicURL: "https://paprika.example/"}
	registry, err := newMCPClientRegistry(t.Context(), cfg, objects, "/mcp")
	require.NoError(t, err)
	assert.Nil(t, registry, "local/test mode remains process-local unless configured")
	cfg.MCPClientRegistryConfigMap = "fleet-clients"
	_, err = newMCPClientRegistry(t.Context(), cfg, objects, "/mcp")
	require.Error(t, err)
	cfg.MCPClientRegistryNamespace = "paprika"
	registry, err = newMCPClientRegistry(t.Context(), cfg, objects, "/mcp")
	require.NoError(t, err)
	require.NotNil(t, registry)
	_, err = newMCPClientRegistry(t.Context(), cfg, objects, "/observe/mcp")
	require.Error(t, err, "the observability server cannot inherit the fleet registry")
	cfg.MCPClientRegistryConfigMap = "missing"
	_, err = newMCPClientRegistry(t.Context(), cfg, objects, "/mcp")
	require.Error(t, err, "persistent storage failures must not fall back to memory")
}
