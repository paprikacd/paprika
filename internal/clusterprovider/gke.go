package clusterprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// gkeAPIBase is the GKE cluster-management endpoint.
const gkeAPIBase = "https://container.googleapis.com"

// containerScope is the OAuth scope the cluster-management API requires.
const containerScope = "https://www.googleapis.com/auth/cloud-platform"

// GKE enriches a Cluster through the GKE cluster-management API. The
// credentials document is a Google credential JSON: a workload identity
// federation external_account configuration or a service-account key — both
// parse through the same x/oauth2 path, so the secret format is the only
// difference an operator sees. With no secret, application default
// credentials carry GKE workload identity.
type GKE struct {
	// APIBase overrides the production endpoint; tests point it at httptest.
	APIBase string
	// tokenSource is the credential seam: a test stubs it, production uses
	// the Google credential resolution below.
	tokenSource func(ctx context.Context, creds []byte) (oauth2.TokenSource, string, error)
	HTTPClient  *http.Client
}

type gkeCluster struct {
	Name                 string        `json:"name"`
	Location             string        `json:"location"`
	Endpoint             string        `json:"endpoint"`
	CurrentMasterVersion string        `json:"currentMasterVersion"`
	Status               string        `json:"status"`
	NodePools            []gkeNodePool `json:"nodePools"`
}

type gkeNodePool struct {
	Name             string `json:"name"`
	InitialNodeCount int32  `json:"initialNodeCount"`
	Version          string `json:"version"`
	Status           string `json:"status"`
	Config           struct {
		MachineType string `json:"machineType"`
	} `json:"config"`
	Autoscaling struct {
		Enabled      bool  `json:"enabled"`
		MinNodeCount int32 `json:"minNodeCount"`
		MaxNodeCount int32 `json:"maxNodeCount"`
	} `json:"autoscaling"`
}

// Describe fetches the cluster by project/location/name. A "-" location is
// the GKE wildcard: a name alone finds the cluster regardless of which zone
// or region holds it.
func (g *GKE) Describe(ctx context.Context, req *Request) (*Details, error) {
	resolve := g.tokenSource
	if resolve == nil {
		resolve = resolveGoogleTokenSource
	}
	source, project, err := resolve(ctx, req.Credentials)
	if err != nil {
		// The error text can carry the token endpoint or audience, so status
		// reports a fixed phrase and the detail stays in the controller log.
		return nil, fmt.Errorf("%w: credential resolution failed", ErrNotConfigured)
	}

	if req.Project != "" {
		project = req.Project
	}
	if project == "" {
		return nil, fmt.Errorf("%w: gke requires spec.provider.project or a credential carrying project_id", ErrNotConfigured)
	}
	if req.ClusterID == "" {
		return nil, fmt.Errorf("%w: gke requires spec.provider.clusterId (the cluster name)", ErrNotConfigured)
	}
	location := req.Region
	if location == "" {
		location = "-"
	}

	base := g.APIBase
	if base == "" {
		base = gkeAPIBase
	}

	var cluster gkeCluster
	url := fmt.Sprintf("%s/v1/projects/%s/locations/%s/clusters/%s", base, project, location, req.ClusterID)
	if err := g.get(ctx, source, url, &cluster); err != nil {
		return nil, err
	}

	pools := make([]clustersv1alpha1.ClusterNodePool, 0, len(cluster.NodePools))
	for _, p := range cluster.NodePools {
		pools = append(pools, clustersv1alpha1.ClusterNodePool{
			Name:        p.Name,
			NodeCount:   p.InitialNodeCount,
			MachineType: p.Config.MachineType,
			MinNodes:    p.Autoscaling.MinNodeCount,
			MaxNodes:    p.Autoscaling.MaxNodeCount,
			AutoScaled:  p.Autoscaling.Enabled,
		})
	}

	return &Details{
		ClusterID: cluster.Name,
		Region:    cluster.Location,
		Version:   cluster.CurrentMasterVersion,
		NodePools: pools,
	}, nil
}

func (g *GKE) get(ctx context.Context, source oauth2.TokenSource, url string, out any) error {
	token, err := source.Token()
	if err != nil {
		return fmt.Errorf("%w: token exchange failed", ErrForbidden)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return fmt.Errorf("building gke request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+token.AccessToken)

	client := g.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("gke api call: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: gke returned %d", ErrForbidden, resp.StatusCode)
	case http.StatusNotFound:
		return ErrNotMatched
	default:
		return fmt.Errorf("gke api returned status %d", resp.StatusCode)
	}

	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("decoding gke response: %w", err)
	}
	return nil
}

// resolveGoogleTokenSource turns the credentials document into a token
// source, returning the project the credential belongs to alongside it.
// The document's declared type is checked before it is loaded — a WIF
// external_account config or a service-account key is expected; a different
// credential type is rejected rather than loaded, which is the mitigation
// google's deprecated untyped loader asks callers to perform. An empty
// document falls through to ADC, the GKE workload-identity path.
func resolveGoogleTokenSource(ctx context.Context, creds []byte) (oauth2.TokenSource, string, error) {
	if len(creds) == 0 {
		adc, err := google.FindDefaultCredentials(ctx, containerScope)
		if err != nil {
			return nil, "", fmt.Errorf("application default credentials: %w", err)
		}
		return adc.TokenSource, adc.ProjectID, nil
	}

	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(creds, &head); err != nil {
		return nil, "", fmt.Errorf("credential document is not valid JSON: %w", err)
	}
	switch head.Type {
	case string(google.ServiceAccount), string(google.ExternalAccount),
		string(google.ImpersonatedServiceAccount):
	default:
		return nil, "", fmt.Errorf(
			"unsupported credential type %q; expected service_account or external_account", head.Type)
	}

	credsParsed, err := google.CredentialsFromJSONWithTypeAndParams(ctx, creds,
		google.CredentialsType(head.Type), google.CredentialsParams{Scopes: []string{containerScope}})
	if err != nil {
		return nil, "", fmt.Errorf("parsing credential document: %w", err)
	}
	return credsParsed.TokenSource, credsParsed.ProjectID, nil
}
