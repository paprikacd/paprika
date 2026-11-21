package observabilitygateway

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"k8s.io/apimachinery/pkg/util/validation"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// AppTelemetryPath accepts short-lived delegated grants for one app and signal.
const AppTelemetryPath = "/observe/api/app-telemetry"

type AppTelemetryConfig struct {
	issuer                string
	audience              string
	keys                  map[string]ed25519.PublicKey
	metricsProvider       string
	logsProvider          string
	restrictDirectQueries bool
}

type appTelemetrySpec struct {
	Issuer                string            `json:"issuer"`
	PublicKeys            map[string]string `json:"publicKeys"`
	MetricsProvider       string            `json:"metricsProvider"`
	LogsProvider          string            `json:"logsProvider"`
	RestrictDirectQueries *bool             `json:"restrictDirectQueries"`
}

// ParseAppTelemetryConfig reads the issuer keys and provider policy.
// An empty configuration leaves the delegated route disabled.
func ParseAppTelemetryConfig(raw, publicURL string) (*AppTelemetryConfig, error) {
	if raw == "" {
		return nil, nil
	}
	audience, err := appTelemetryAudience(publicURL)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	var spec appTelemetrySpec
	if err = dec.Decode(&spec); err != nil || dec.Decode(new(any)) != io.EOF {
		return nil, errors.New("invalid app telemetry configuration")
	}
	if err = spec.validate(); err != nil {
		return nil, err
	}
	keys, err := appTelemetryKeys(spec.PublicKeys)
	if err != nil {
		return nil, err
	}
	return &AppTelemetryConfig{
		issuer: spec.Issuer, audience: audience, keys: keys,
		metricsProvider: spec.MetricsProvider, logsProvider: spec.LogsProvider,
		restrictDirectQueries: spec.RestrictDirectQueries == nil || *spec.RestrictDirectQueries,
	}, nil
}

func appTelemetryAudience(publicURL string) (string, error) {
	origin, err := url.Parse(strings.TrimRight(publicURL, "/"))
	if err != nil || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
		return "", errors.New("app telemetry requires an HTTPS gateway origin")
	}
	return origin.String() + AppTelemetryPath, nil
}

func (s *appTelemetrySpec) validate() error {
	if strings.TrimSpace(s.Issuer) == "" || len(s.Issuer) > 128 ||
		len(s.PublicKeys) == 0 || len(s.PublicKeys) > 4 {
		return errors.New("app telemetry requires an issuer and one to four verification keys")
	}
	if s.MetricsProvider == s.LogsProvider {
		return errors.New("app telemetry requires distinct configured providers for each enabled signal")
	}
	if !validAppTelemetryProvider(s.MetricsProvider) || !validAppTelemetryProvider(s.LogsProvider) {
		return errors.New("app telemetry provider must be namespace/name")
	}
	return nil
}

func validAppTelemetryProvider(provider string) bool {
	if provider == "" {
		return true
	}
	ns, name, ok := strings.Cut(provider, "/")
	return ok && len(validation.IsDNS1123Label(ns)) == 0 && len(validation.IsDNS1123Subdomain(name)) == 0
}

func appTelemetryKeys(pems map[string]string) (map[string]ed25519.PublicKey, error) {
	keys := make(map[string]ed25519.PublicKey, len(pems))
	for id, encoded := range pems {
		block, rest := pem.Decode([]byte(encoded))
		if len(validation.IsDNS1123Label(id)) != 0 || block == nil || block.Type != "PUBLIC KEY" ||
			strings.TrimSpace(string(rest)) != "" {
			return nil, errors.New("invalid app telemetry verification key")
		}
		parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
		key, ok := parsed.(ed25519.PublicKey)
		if err != nil || !ok {
			return nil, errors.New("app telemetry verification key must be Ed25519")
		}
		keys[id] = key
	}
	return keys, nil
}

// RestrictedProviders are reserved for the app telemetry route. Interactive
// query and discovery endpoints using the generic backend cannot use them.
func (c *AppTelemetryConfig) RestrictedProviders() []string {
	if c == nil || !c.restrictDirectQueries {
		return nil
	}
	return []string{c.metricsProvider, c.logsProvider}
}

type appTelemetryGrant struct {
	jwt.RegisteredClaims
	Tenant string `json:"tenant"`
	App    string `json:"app"`
	Signal string `json:"signal"`
}

func (c *AppTelemetryConfig) verify(header string, now time.Time) (*appTelemetryGrant, error) {
	scheme, raw, ok := strings.Cut(header, " ")
	invalid := errors.New("invalid app telemetry grant")
	if !ok || !strings.EqualFold(scheme, "Bearer") || raw == "" || len(raw) > 4096 {
		return nil, invalid
	}
	claims := &appTelemetryGrant{}
	_, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		id, hasID := token.Header["kid"].(string)
		key, ok := c.keys[id]
		if !hasID || !ok {
			return nil, invalid
		}
		return key, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}), jwt.WithIssuer(c.issuer),
		jwt.WithAudience(c.audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(),
		jwt.WithLeeway(3*time.Second), jwt.WithTimeFunc(func() time.Time { return now }))
	if err != nil || !claims.valid() {
		return nil, invalid
	}
	return claims, nil
}

func (g *appTelemetryGrant) valid() bool {
	if g.IssuedAt == nil || g.ExpiresAt == nil || len(g.Audience) != 1 {
		return false
	}
	lifetime := g.ExpiresAt.Sub(g.IssuedAt.Time)
	return lifetime > 0 && lifetime <= time.Minute && validAppTelemetryIdentity(g) &&
		(g.Signal == "metrics" || g.Signal == "logs")
}

func validAppTelemetryIdentity(g *appTelemetryGrant) bool {
	prefix := g.Tenant + "-"
	return strings.TrimSpace(g.Subject) != "" && len(g.Subject) <= 512 &&
		len(validation.IsDNS1123Label(g.Tenant)) == 0 && len(validation.IsDNS1123Label(g.App)) == 0 &&
		strings.HasPrefix(g.App, prefix) && len(g.App) > len(prefix)
}

func (g *appTelemetryGrant) matches(labels map[string]string) bool {
	return labels["tenant"] == g.Tenant && labels["app"] == g.App
}

type appTelemetryQuery func(context.Context, string, string, connector.QueryRequest) (*connector.QueryResult, error)

// Handler exposes the narrow read route as a distinct trust boundary. It
// authenticates and scopes requests before the trusted backend resolves a
// provider or its credentials.
func (c *AppTelemetryConfig) Handler(k8sClient client.Client, budget BudgetConfig) http.Handler {
	backend := &k8sBackend{client: k8sClient, budgetConfig: budget}
	return c.handler(backend.query)
}

func (c *AppTelemetryConfig) handler(query appTelemetryQuery) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		grants := r.Header.Values("Authorization")
		if len(grants) != 1 {
			writeGatewayJSON(w, http.StatusUnauthorized, gatewayError{Error: "invalid_token"})
			return
		}
		now := time.Now().UTC()
		grant, err := c.verify(grants[0], now)
		if err != nil {
			writeGatewayJSON(w, http.StatusUnauthorized, gatewayError{Error: "invalid_token"})
			return
		}
		if r.URL.RawQuery != "" || r.URL.ForceQuery || r.ContentLength != 0 {
			writeGatewayJSON(w, http.StatusBadRequest, gatewayError{Error: "invalid_request"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		result := c.readAppTelemetry(ctx, query, grant, now)
		writeGatewayJSON(w, http.StatusOK, result)
	})
}

func (c *AppTelemetryConfig) readAppTelemetry(ctx context.Context, query appTelemetryQuery, grant *appTelemetryGrant, now time.Time) appTelemetryResult {
	selector := fmt.Sprintf("tenant=%q,app=%q", grant.Tenant, grant.App)
	req := connector.QueryRequest{
		Signal: connector.SignalLogs, Query: "{" + selector + "}", Limit: 50,
		Range: connector.TimeRange{Start: now.Add(-15 * time.Minute), End: now},
	}
	provider, kind := c.logsProvider, connector.ProviderLoki
	if grant.Signal == "metrics" {
		provider, kind = c.metricsProvider, connector.ProviderPrometheus
		req.Signal, req.Query, req.Limit = connector.SignalMetrics, appTrafficQuery(selector), 3
		req.Instant = true
	}
	if provider == "" {
		return appTelemetryResult{State: "not_configured"}
	}
	result, err := query(ctx, provider, kind, req)
	if err != nil || result == nil || result.State != connector.StateOK {
		return appTelemetryResult{State: "unavailable"}
	}
	if grant.Signal == "metrics" {
		return appTrafficResult(result.Data, grant)
	}
	return appLogsResult(result.Data, grant, req.Range)
}
