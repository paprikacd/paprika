package clusterprovider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAKSDescribe(t *testing.T) {
	t.Parallel()

	var tokenForm url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/tenant-1/oauth2/v2.0/token":
			require.NoError(t, r.ParseForm())
			tokenForm = r.Form
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "mgmt-token"})
		case r.URL.Path == "/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ContainerService/managedClusters/prod-aks":
			require.Equal(t, "Bearer mgmt-token", r.Header.Get("Authorization"))
			require.Equal(t, aksAPIVersion, r.URL.Query().Get("api-version"))
			_ = json.NewEncoder(w).Encode(map[string]any{
				"name": "prod-aks", "location": "australiaeast",
				"properties": map[string]any{
					"fqdn":              "prod-aks.hcp.australiaeast.azmk8s.io",
					"kubernetesVersion": "1.30.3",
					"agentPoolProfiles": []map[string]any{{
						"name": "system", "count": 3, "vmSize": "Standard_D4s_v5",
						"enableAutoScaling": true, "minCount": 1, "maxCount": 5,
					}},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	a := &AKS{AuthorityHost: server.URL, ManagementHost: server.URL}
	details, err := a.Describe(context.Background(), &Request{
		ClusterID:      "prod-aks",
		Project:        "rg-1",
		SubscriptionID: "sub-1",
		Credentials:    []byte(`{"tenant_id":"tenant-1","client_id":"client-1","client_secret":"s3cret"}`),
	})
	require.NoError(t, err)
	require.Equal(t, "s3cret", tokenForm.Get("client_secret"))
	require.Equal(t, "prod-aks", details.ClusterID)
	require.Equal(t, "australiaeast", details.Region)
	require.Equal(t, "1.30.3", details.Version)
	require.Len(t, details.NodePools, 1)
	require.Equal(t, "system", details.NodePools[0].Name)
	require.Equal(t, "Standard_D4s_v5", details.NodePools[0].MachineType)
	require.True(t, details.NodePools[0].AutoScaled)
	require.Equal(t, int32(5), details.NodePools[0].MaxNodes)
}

func TestAKSDescribeMissingInputs(t *testing.T) {
	t.Parallel()

	a := &AKS{}

	t.Run("no credential and no WI env", func(t *testing.T) {
		_, err := a.Describe(context.Background(), &Request{
			ClusterID: "c", Project: "rg", SubscriptionID: "sub",
		})
		require.ErrorIs(t, err, ErrNotConfigured)
	})

	t.Run("identity fields required", func(t *testing.T) {
		_, err := a.Describe(context.Background(), &Request{
			ClusterID:   "c",
			Credentials: []byte(`{"tenant_id":"t","client_id":"c","client_secret":"s"}`),
		})
		require.ErrorIs(t, err, ErrNotConfigured)
	})
}
