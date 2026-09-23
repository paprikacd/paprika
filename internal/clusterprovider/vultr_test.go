package clusterprovider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVultrDescribeByClusterID(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))
		require.Equal(t, "/v2/kubernetes/clusters/vke-123", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"vke_cluster": map[string]any{
				"id": "vke-123", "label": "prod", "region": "syd", "version": "v1.36.1",
				"endpoint": "vke-123.vultr.com",
				"node_pools": []map[string]any{{
					"id": "pool-1", "label": "core", "plan": "vc2-2c-4gb",
					"status": "active", "count": 3,
					"auto_scaler": true, "min_nodes": 2, "max_nodes": 8,
				}},
			},
		})
	}))
	defer server.Close()

	v := &Vultr{APIBase: server.URL}
	details, err := v.Describe(context.Background(), &Request{
		ClusterID:   "vke-123",
		Credentials: []byte("test-key"),
	})
	require.NoError(t, err)
	require.Equal(t, "vke-123", details.ClusterID)
	require.Equal(t, "syd", details.Region)
	require.Equal(t, "v1.36.1", details.Version)
	require.Len(t, details.NodePools, 1)
	require.Equal(t, "core", details.NodePools[0].Name)
	require.Equal(t, int32(3), details.NodePools[0].NodeCount)
	require.Equal(t, "vc2-2c-4gb", details.NodePools[0].MachineType)
	require.True(t, details.NodePools[0].AutoScaled)
	require.Equal(t, int32(2), details.NodePools[0].MinNodes)
	require.Equal(t, int32(8), details.NodePools[0].MaxNodes)
}

func TestVultrDescribeMatchesByEndpoint(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v2/kubernetes/clusters":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"vke_clusters": []map[string]any{
					{"id": "other", "endpoint": "other.vultr.com"},
					{"id": "vke-123", "endpoint": "https://vke-123.vultr.com:6443"},
				},
			})
		case "/v2/kubernetes/clusters/vke-123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"vke_cluster": map[string]any{"id": "vke-123", "region": "syd"},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	v := &Vultr{APIBase: server.URL}
	details, err := v.Describe(context.Background(), &Request{
		Endpoint:    "https://vke-123.vultr.com:6443",
		Credentials: []byte("test-key"),
	})
	require.NoError(t, err)
	require.Equal(t, "vke-123", details.ClusterID)
}

func TestVultrDescribeErrorStates(t *testing.T) {
	t.Parallel()

	t.Run("no credential", func(t *testing.T) {
		t.Parallel()
		v := &Vultr{APIBase: "http://unused.invalid"}
		_, err := v.Describe(context.Background(), &Request{ClusterID: "x"})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("forbidden", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer server.Close()
		v := &Vultr{APIBase: server.URL}
		_, err := v.Describe(context.Background(), &Request{ClusterID: "x", Credentials: []byte("bad")})
		require.ErrorIs(t, err, ErrForbidden)
	})

	t.Run("no match", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{"vke_clusters": []map[string]any{}})
		}))
		defer server.Close()
		v := &Vultr{APIBase: server.URL}
		_, err := v.Describe(context.Background(), &Request{
			Endpoint: "https://nope.example.com", Credentials: []byte("k"),
		})
		require.ErrorIs(t, err, ErrNotMatched)
	})

	t.Run("in-cluster endpoint never matches", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"vke_clusters": []map[string]any{{"id": "x", "endpoint": "real.vultr.com"}},
			})
		}))
		defer server.Close()
		v := &Vultr{APIBase: server.URL}
		// kubernetes.default.svc is a valid hostname but one Vultr never
		// publishes, so the answer is NotMatched — the spec's clusterID is
		// the fix the status reason names.
		_, err := v.Describe(context.Background(), &Request{
			Endpoint: "https://kubernetes.default.svc", Credentials: []byte("k"),
		})
		require.ErrorIs(t, err, ErrNotMatched)
	})
}
