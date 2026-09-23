package clusterprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// vultrAPIBase is the Vultr API v2 root; a field so tests can point it at an
// httptest server.
const vultrAPIBase = "https://api.vultr.com"

// Vultr enriches a Cluster through the Vultr VKE API. The credential is a
// personal access token carried as a Bearer header; there is no ambient
// identity for it to fall back to, so a missing credential is NotConfigured.
type Vultr struct {
	// APIBase overrides the production endpoint; nil/empty means default.
	APIBase string
	// HTTPClient overrides the default transport; tests inject a server.
	HTTPClient *http.Client
}

//nolint:tagliatelle // Vultr v2 wire fields are snake_case.
type vultrCluster struct {
	ID        string          `json:"id"`
	Label     string          `json:"label"`
	Region    string          `json:"region"`
	Version   string          `json:"version"`
	Status    string          `json:"status"`
	Endpoint  string          `json:"endpoint"`
	NodePools []vultrNodePool `json:"node_pools"`
}

//nolint:tagliatelle // Vultr v2 wire fields are snake_case.
type vultrNodePool struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	Plan       string `json:"plan"`
	Status     string `json:"status"`
	Count      int32  `json:"count"`
	AutoScaler bool   `json:"auto_scaler"`
	MinNodes   int32  `json:"min_nodes"`
	MaxNodes   int32  `json:"max_nodes"`
}

// Describe resolves the VKE cluster — by ID when the spec names one, by
// apiserver endpoint otherwise — and returns its provider-reported shape.
func (v *Vultr) Describe(ctx context.Context, req *Request) (*Details, error) {
	apiKey := strings.TrimSpace(string(req.Credentials))
	if apiKey == "" {
		return nil, fmt.Errorf("%w: vultr requires credentialsSecretRef containing an API key", ErrNotConfigured)
	}

	base := v.APIBase
	if base == "" {
		base = vultrAPIBase
	}

	var cluster *vultrCluster
	var err error
	if req.ClusterID != "" {
		cluster, err = v.getCluster(ctx, base, apiKey, req.ClusterID)
	} else {
		cluster, err = v.matchByEndpoint(ctx, base, apiKey, req.Endpoint)
	}
	if err != nil {
		return nil, err
	}

	pools := make([]clustersv1alpha1.ClusterNodePool, 0, len(cluster.NodePools))
	for _, p := range cluster.NodePools {
		pools = append(pools, clustersv1alpha1.ClusterNodePool{
			Name:        p.Label,
			NodeCount:   p.Count,
			MachineType: p.Plan,
			MinNodes:    p.MinNodes,
			MaxNodes:    p.MaxNodes,
			AutoScaled:  p.AutoScaler,
		})
	}

	return &Details{
		ClusterID: cluster.ID,
		Region:    cluster.Region,
		Version:   cluster.Version,
		NodePools: pools,
	}, nil
}

func (v *Vultr) getCluster(ctx context.Context, base, apiKey, id string) (*vultrCluster, error) {
	var body struct {
		Cluster vultrCluster `json:"vke_cluster"` //nolint:tagliatelle // Vultr wire field.
	}
	if err := v.get(ctx, base+"/v2/kubernetes/clusters/"+id, apiKey, &body); err != nil {
		return nil, err
	}
	return &body.Cluster, nil
}

// matchByEndpoint lists the account's VKE clusters and matches the one whose
// published endpoint is the apiserver Paprika reached. A cluster registered
// in-cluster has a kubernetes.default.svc endpoint nothing can match, which
// surfaces as ErrNotMatched — the spec's clusterID is the fix.
func (v *Vultr) matchByEndpoint(ctx context.Context, base, apiKey, endpoint string) (*vultrCluster, error) {
	host := endpointHost(endpoint)
	if host == "" {
		return nil, ErrNotMatched
	}

	var body struct {
		Clusters []vultrCluster `json:"vke_clusters"` //nolint:tagliatelle // Vultr wire field.
	}
	if err := v.get(ctx, base+"/v2/kubernetes/clusters", apiKey, &body); err != nil {
		return nil, err
	}
	for i := range body.Clusters {
		if endpointHost(body.Clusters[i].Endpoint) == host {
			id := body.Clusters[i].ID
			return v.getCluster(ctx, base, apiKey, id)
		}
	}
	return nil, ErrNotMatched
}

func (v *Vultr) get(ctx context.Context, url, apiKey string, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return fmt.Errorf("building vultr request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := v.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("vultr api call: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: vultr returned %d", ErrForbidden, resp.StatusCode)
	case http.StatusNotFound:
		return ErrNotMatched
	default:
		return fmt.Errorf("vultr api returned status %d", resp.StatusCode)
	}

	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("decoding vultr response: %w", err)
	}
	return nil
}

// endpointHost reduces an apiserver URL or host:port to the hostname a
// provider publishes in its own endpoint field.
func endpointHost(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
