package clusterprovider

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
)

// aksAuthorityHost and aksScope are the public-cloud endpoints. Sovereign
// clouds are out of scope for the first cut — the credential document shape
// already isolates the difference if they are ever needed.
const (
	aksAuthorityHost    = "https://login.microsoftonline.com"
	aksManagementHost   = "https://management.azure.com"
	aksScope            = "https://management.azure.com/.default"
	aksAPIVersion       = "2024-05-01"
	aksJWTAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
)

// AKS enriches a Cluster through the Azure control-plane API. The
// credentials document is a service principal ({tenant_id, client_id,
// client_secret}) or a workload-identity pair ({tenant_id, client_id,
// federated_token_file}); absent a secret, the AZURE_* workload-identity
// environment is used, which is what AKS pods run under by default.
type AKS struct {
	// AuthorityHost and ManagementHost exist so tests can run without Azure.
	AuthorityHost  string
	ManagementHost string
	HTTPClient     *http.Client
}

// aksCredentialsDocument is the JSON shape credentialsSecretRef carries for
// AKS. federated_token_file points at a pod-mounted JWT (Azure workload
// identity); client_secret is the service-principal path.
//
//nolint:tagliatelle // credential document fields follow cloud JSON conventions.
type aksCredentialsDocument struct {
	TenantID           string `json:"tenant_id"`
	ClientID           string `json:"client_id"`
	ClientSecret       string `json:"client_secret,omitempty"`
	FederatedTokenFile string `json:"federated_token_file,omitempty"`
}

type aksCluster struct {
	Name       string `json:"name"`
	Location   string `json:"location"`
	Properties struct {
		Fqdn              string `json:"fqdn"`
		KubernetesVersion string `json:"kubernetesVersion"`
		AgentPoolProfiles []struct {
			Name              string `json:"name"`
			Count             int32  `json:"count"`
			VMSize            string `json:"vmSize"`
			EnableAutoScaling bool   `json:"enableAutoScaling"`
			MinCount          int32  `json:"minCount"`
			MaxCount          int32  `json:"maxCount"`
		} `json:"agentPoolProfiles"`
	} `json:"properties"`
}

// Describe fetches the managed cluster by subscription/resource-group/name.
// All three are required — Azure offers no list-and-match endpoint cheap
// enough to be worth a fleet-wide scan per reconcile.
func (a *AKS) Describe(ctx context.Context, req *Request) (*Details, error) {
	creds, err := a.credentials(req.Credentials)
	if err != nil {
		return nil, err
	}
	if req.SubscriptionID == "" || req.Project == "" || req.ClusterID == "" {
		return nil, fmt.Errorf(
			"%w: aks requires spec.provider.subscriptionId, project (resource group) and clusterID",
			ErrNotConfigured)
	}

	token, err := a.token(ctx, creds)
	if err != nil {
		return nil, err
	}

	mgmt := a.ManagementHost
	if mgmt == "" {
		mgmt = aksManagementHost
	}
	path := fmt.Sprintf("%s/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ContainerService/managedClusters/%s",
		mgmt, req.SubscriptionID, req.Project, req.ClusterID)

	var cluster aksCluster
	if err := a.get(ctx, token, path+"?api-version="+aksAPIVersion, &cluster); err != nil {
		return nil, err
	}

	pools := make([]clustersv1alpha1.ClusterNodePool, 0, len(cluster.Properties.AgentPoolProfiles))
	for _, p := range cluster.Properties.AgentPoolProfiles {
		pools = append(pools, clustersv1alpha1.ClusterNodePool{
			Name:        p.Name,
			NodeCount:   p.Count,
			MachineType: p.VMSize,
			MinNodes:    p.MinCount,
			MaxNodes:    p.MaxCount,
			AutoScaled:  p.EnableAutoScaling,
		})
	}

	return &Details{
		ClusterID: cluster.Name,
		Region:    cluster.Location,
		Version:   cluster.Properties.KubernetesVersion,
		NodePools: pools,
	}, nil
}

// credentials resolves the AKS identity: the secret document when one is
// configured, else the workload-identity environment Azure injects into pods.
// Every failure wraps ErrNotConfigured — a credential problem is a
// configuration fact, not a provider outage.
func (a *AKS) credentials(raw []byte) (*aksCredentialsDocument, error) {
	if len(raw) > 0 {
		var doc aksCredentialsDocument
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, fmt.Errorf("%w: credentials document is not valid JSON", ErrNotConfigured)
		}
		if doc.TenantID == "" || doc.ClientID == "" ||
			(doc.ClientSecret == "" && doc.FederatedTokenFile == "") {
			return nil, fmt.Errorf("%w: credentials document requires tenant_id, client_id and "+
				"client_secret or federated_token_file", ErrNotConfigured)
		}
		return &doc, nil
	}

	tenant, clientID, tokenFile :=
		os.Getenv("AZURE_TENANT_ID"), os.Getenv("AZURE_CLIENT_ID"), os.Getenv("AZURE_FEDERATED_TOKEN_FILE")
	if tenant == "" || clientID == "" || tokenFile == "" {
		return nil, fmt.Errorf("%w: aks requires credentialsSecretRef or the AZURE_* "+
			"workload-identity environment", ErrNotConfigured)
	}
	return &aksCredentialsDocument{TenantID: tenant, ClientID: clientID, FederatedTokenFile: tokenFile}, nil
}

// token exchanges the credential for a management-plane access token. The
// two shapes share one endpoint: client_secret is a password grant,
// federated_token_file is a JWT-bearer client assertion.
func (a *AKS) token(ctx context.Context, creds *aksCredentialsDocument) (string, error) {
	form := url.Values{
		"grant_type": {"client_credentials"},
		"client_id":  {creds.ClientID},
		"scope":      {aksScope},
	}
	if creds.ClientSecret != "" {
		form.Set("client_secret", creds.ClientSecret)
	} else {
		assertion, err := os.ReadFile(creds.FederatedTokenFile)
		if err != nil {
			return "", fmt.Errorf("%w: reading federated token file", ErrNotConfigured)
		}
		form.Set("client_assertion", strings.TrimSpace(string(assertion)))
		form.Set("client_assertion_type", aksJWTAssertionType)
	}

	authority := a.AuthorityHost
	if authority == "" {
		authority = aksAuthorityHost
	}
	tokenURL := fmt.Sprintf("%s/%s/oauth2/v2.0/token", authority, creds.TenantID)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("building token request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := a.httpClient().Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("azure token request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%w: azure token endpoint returned %d", ErrForbidden, resp.StatusCode)
	}

	var body struct {
		AccessToken string `json:"access_token"` //nolint:tagliatelle // OAuth wire field.
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("decoding azure token response: %w", err)
	}
	if body.AccessToken == "" {
		return "", fmt.Errorf("%w: azure token response carried no access_token", ErrForbidden)
	}
	return body.AccessToken, nil
}

func (a *AKS) get(ctx context.Context, token, url string, out any) error {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		return fmt.Errorf("building aks request: %w", err)
	}
	httpReq.Header.Set("Authorization", "Bearer "+token)

	resp, err := a.httpClient().Do(httpReq)
	if err != nil {
		return fmt.Errorf("aks api call: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: aks returned %d", ErrForbidden, resp.StatusCode)
	case http.StatusNotFound:
		return ErrNotMatched
	default:
		return fmt.Errorf("aks api returned status %d", resp.StatusCode)
	}

	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("decoding aks response: %w", err)
	}
	return nil
}

func (a *AKS) httpClient() *http.Client {
	if a.HTTPClient != nil {
		return a.HTTPClient
	}
	return http.DefaultClient
}
