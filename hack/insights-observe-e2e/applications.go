package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	observev1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
)

const fixtureOrg = "82bbc22b-0279-4f27-a404-bf30f96aee7d"
const fixtureServiceA = "ab64147d-1ffb-4850-916a-56b5146cb7ad"
const fixtureServiceB = "ab64147d-1ffb-4850-916a-56b5146cb7ae"

type applicationProviderFixture struct {
	Name        string          `json:"name"`
	Type        string          `json:"type"`
	Config      json.RawMessage `json:"config"`
	Credentials json.RawMessage `json:"credentials"`
}

func applicationFixtureObjects(endpoint, providerFile string, providerStdin bool) ([]client.Object, error) {
	shortedConfig, err := json.Marshal(map[string]string{"endpoint": endpoint})
	if err != nil {
		return nil, errors.New("application fixture configuration failed")
	}
	uptimeConfig, err := json.Marshal(map[string]string{"endpoint": endpoint, "orgId": fixtureOrg})
	if err != nil {
		return nil, errors.New("application fixture configuration failed")
	}
	providers := []applicationProviderFixture{
		{Name: "shorted", Type: "shorted", Config: shortedConfig, Credentials: json.RawMessage(`{"apiToken":"fixture-provider-secret"}`)},
		{Name: "uptime", Type: "uptime", Config: uptimeConfig, Credentials: json.RawMessage(`"fixture-provider-secret"`)},
	}
	if providerFile != "" || providerStdin {
		extra, readErr := readApplicationProviders(providerFile, providerStdin)
		if readErr != nil {
			return nil, readErr
		}
		providers = append(providers, extra...)
	}
	objects := make([]client.Object, 0, len(providers)*2)
	for _, provider := range providers {
		if provider.Name == "" || provider.Type == "" {
			return nil, errors.New("application fixture provider identity is required")
		}
		credentials := []byte(provider.Credentials)
		var rawToken string
		stringCredentials := json.Unmarshal(provider.Credentials, &rawToken) == nil
		if stringCredentials {
			credentials = []byte(rawToken)
		}
		fixture := &observev1.ObservabilityProvider{ObjectMeta: metav1.ObjectMeta{Name: provider.Name, Namespace: "observability"}, Spec: observev1.ObservabilityProviderSpec{Type: provider.Type, Config: runtime.RawExtension{Raw: provider.Config}}}
		// An explicitly empty string asks for anonymous access. Omitted or null
		// credentials do not silently grant that behavior: retain their Secret
		// reference so the gateway's normal validation reports the error.
		if strings.TrimSpace(string(provider.Credentials)) != `""` {
			fixture.Spec.CredentialsSecretRef = &observev1.CredentialsSecretRef{Name: provider.Name + "-credentials"}
			objects = append(objects, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: provider.Name + "-credentials", Namespace: "observability", Labels: map[string]string{observev1.CredentialsSecretLabel: "true"}}, Data: map[string][]byte{"credentials": credentials}})
		}
		objects = append(objects, fixture)
	}
	return objects, nil
}

func readApplicationProviders(path string, fromStdin bool) ([]applicationProviderFixture, error) {
	if fromStdin {
		if path != "" {
			return nil, errors.New("choose one private provider fixture input")
		}
		return decodeApplicationProviders(os.Stdin)
	}
	// The operator-supplied test file is deliberately private and never copied
	// into the readiness receipt, diagnostics or report artifacts.
	file, err := os.Open(path) //nolint:gosec // Explicit local integration-test input; no remote path or API request controls this.
	if err != nil {
		return nil, errors.New("application provider fixture file could not be read")
	}
	defer func() { _ = file.Close() }() //nolint:errcheck // Read-only fixture input.
	return decodeApplicationProviders(file)
}

func decodeApplicationProviders(reader io.Reader) ([]applicationProviderFixture, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, (32<<10)+1))
	if err != nil || len(raw) > 32<<10 {
		return nil, errors.New("application provider fixture file could not be read")
	}
	var providers []applicationProviderFixture
	if json.Unmarshal(raw, &providers) != nil || len(providers) > 4 {
		return nil, errors.New("application provider fixture file is invalid")
	}
	return providers, nil
}

func (f *telemetryFixture) serveApplicationFixture(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/uptimeapi.v1.") && !strings.HasPrefix(r.URL.Path, "/shorts.v1alpha1.") {
		return false
	}
	body := applicationBody(w, r)
	if body == nil {
		return true
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return true
	}
	f.mu.Lock()
	f.requests = append(f.requests, map[string]string{"path": r.URL.Path, "query": string(encoded)})
	f.mu.Unlock()
	switch r.URL.Path {
	case "/uptimeapi.v1.ServiceService/ListServices":
		jsonResponse(w, map[string]any{"services": []any{map[string]string{"id": fixtureServiceA, "name": "Checkout", "slug": "checkout"}, map[string]string{"id": fixtureServiceB, "name": "Payments", "slug": "payments"}}})
	case "/uptimeapi.v1.ServiceService/GetSLODashboard":
		jsonResponse(w, map[string]any{"services": []any{map[string]any{"serviceId": fixtureServiceA, "serviceName": "Checkout", "currentUptime": 99.97, "slaTarget": 99.9, "totalChecks": 10000, "failedChecks": 3, "errorBudgetPercentage": 70}, map[string]any{"serviceId": fixtureServiceB, "serviceName": "Payments", "currentUptime": 98.21, "slaTarget": 99.9, "totalChecks": 10000, "failedChecks": 179, "errorBudgetPercentage": 0, "slaBreached": true}}})
	case "/shorts.v1alpha1.MarketService/GetTopShorts":
		jsonResponse(w, map[string]any{"timeSeries": []any{map[string]any{"productCode": "CBA", "latestShortPosition": 1.25}, map[string]any{"productCode": "BHP", "latestShortPosition": 2.5}}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
	return true
}

func applicationBody(w http.ResponseWriter, r *http.Request) map[string]any {
	var body map[string]any
	if r.Method != http.MethodPost || json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return nil
	}
	if strings.HasPrefix(r.URL.Path, "/uptimeapi.v1.") && body["orgId"] != fixtureOrg {
		w.WriteHeader(http.StatusForbidden)
		return nil
	}
	return body
}
