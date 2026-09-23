package clusterprovider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

type staticToken struct{ token string }

func (s staticToken) Token() (*oauth2.Token, error) { return &oauth2.Token{AccessToken: s.token}, nil }

func gkeSource(token, project string, err error) func(context.Context, []byte) (oauth2.TokenSource, string, error) {
	return func(context.Context, []byte) (oauth2.TokenSource, string, error) {
		return staticToken{token: token}, project, err
	}
}

func TestGKEDescribe(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer tok", r.Header.Get("Authorization"))
		require.Equal(t, "/v1/projects/my-proj/locations/-/clusters/prod-gke", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name": "prod-gke", "location": "australia-southeast1",
			"currentMasterVersion": "1.31.4-gke.1", "status": "RUNNING",
			"nodePools": []map[string]any{{
				"name": "default-pool", "initialNodeCount": 3,
				"config":      map[string]any{"machineType": "e2-standard-4"},
				"autoscaling": map[string]any{"enabled": true, "minNodeCount": 1, "maxNodeCount": 10},
			}},
		})
	}))
	defer server.Close()

	g := &GKE{APIBase: server.URL, tokenSource: gkeSource("tok", "cred-project", nil)}
	details, err := g.Describe(context.Background(), &Request{
		ClusterID: "prod-gke",
		Project:   "my-proj",
	})
	require.NoError(t, err)
	require.Equal(t, "prod-gke", details.ClusterID)
	require.Equal(t, "australia-southeast1", details.Region)
	require.Equal(t, "1.31.4-gke.1", details.Version)
	require.Len(t, details.NodePools, 1)
	require.Equal(t, "e2-standard-4", details.NodePools[0].MachineType)
	require.True(t, details.NodePools[0].AutoScaled)
	require.Equal(t, int32(10), details.NodePools[0].MaxNodes)
}

func TestGKEDescribeMissingInputs(t *testing.T) {
	t.Parallel()

	t.Run("credential resolution fails", func(t *testing.T) {
		t.Parallel()
		g := &GKE{tokenSource: gkeSource("", "", errors.New("no creds"))}
		_, err := g.Describe(context.Background(), &Request{ClusterID: "x", Project: "p"})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("no project anywhere", func(t *testing.T) {
		t.Parallel()
		g := &GKE{tokenSource: gkeSource("tok", "", nil)}
		_, err := g.Describe(context.Background(), &Request{ClusterID: "x"})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("no cluster name", func(t *testing.T) {
		t.Parallel()
		g := &GKE{tokenSource: gkeSource("tok", "p", nil)}
		_, err := g.Describe(context.Background(), &Request{Project: "p"})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("credential project used when spec empty", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Contains(t, r.URL.Path, "/projects/cred-proj/")
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "c", "location": "us"})
		}))
		defer server.Close()
		g := &GKE{APIBase: server.URL, tokenSource: gkeSource("tok", "cred-proj", nil)}
		details, err := g.Describe(context.Background(), &Request{ClusterID: "c"})
		require.NoError(t, err)
		require.Equal(t, "us", details.Region)
	})

	t.Run("forbidden", func(t *testing.T) {
		t.Parallel()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		}))
		defer server.Close()
		g := &GKE{APIBase: server.URL, tokenSource: gkeSource("tok", "p", nil)}
		_, err := g.Describe(context.Background(), &Request{ClusterID: "c", Project: "p"})
		require.ErrorIs(t, err, ErrForbidden)
	})
}
