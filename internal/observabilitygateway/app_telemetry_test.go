package observabilitygateway

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func telemetryTestConfig(t *testing.T) (*AppTelemetryConfig, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	der, err := x509.MarshalPKIXPublicKey(public)
	require.NoError(t, err)
	publicPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	spec := fmt.Sprintf(`{"issuer":"deephost-test","publicKeys":{"key-one":%q},"metricsProvider":"obs/traffic","logsProvider":"obs/runtime"}`, string(publicPEM))
	cfg, err := ParseAppTelemetryConfig(spec, "https://observe.example")
	require.NoError(t, err)
	return cfg, private
}

func telemetryTestGrant(audience, signal string, now time.Time) appTelemetryGrant {
	return appTelemetryGrant{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: "deephost-test", Subject: "google:member-one",
			Audience: jwt.ClaimStrings{audience}, IssuedAt: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(45 * time.Second)),
		},
		Tenant: "tenant-one", App: "tenant-one-storefront", Signal: signal,
	}
}

func telemetryTestToken(t *testing.T, grant appTelemetryGrant, key ed25519.PrivateKey, keyID string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, grant)
	token.Header["kid"] = keyID
	raw, err := token.SignedString(key)
	require.NoError(t, err)
	return raw
}

func serveAppTelemetry(t *testing.T, handler http.Handler, token, query string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, AppTelemetryPath+query, nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, request)
	require.Equal(t, "no-store", out.Header().Get("Cache-Control"))
	return out
}

func TestAppTelemetryBuildsBoundedAppReads(t *testing.T) {
	t.Parallel()
	config, key := telemetryTestConfig(t)
	const selector = `tenant="tenant-one",app="tenant-one-storefront"`
	handler := config.handler(func(_ context.Context, provider, kind string, req connector.QueryRequest) (*connector.QueryResult, error) {
		switch req.Signal {
		case connector.SignalMetrics:
			require.Equal(t, "obs/traffic", provider)
			require.Equal(t, connector.ProviderPrometheus, kind)
			require.True(t, req.Instant)
			require.Equal(t, 3, req.Limit)
			require.Contains(t, req.Query, "{"+selector+"}")
			require.Contains(t, req.Query, "sum by (tenant,app)")
			return &connector.QueryResult{State: connector.StateOK,
				Data: json.RawMessage(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"tenant":"tenant-one","app":"tenant-one-storefront","metric":"requests_24h"},"value":[1,"27"]}]}}`)}, nil
		case connector.SignalLogs:
			require.Equal(t, "obs/runtime", provider)
			require.Equal(t, connector.ProviderLoki, kind)
			require.Equal(t, "{"+selector+"}", req.Query)
			require.Equal(t, 50, req.Limit)
			require.Equal(t, 15*time.Minute, req.Range.End.Sub(req.Range.Start))
			line := fmt.Sprintf(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"tenant":"tenant-one","app":"tenant-one-storefront"},"values":[[%q,"site ready"]]}]}}`,
				fmt.Sprint(req.Range.End.Add(-time.Second).UnixNano()))
			return &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(line)}, nil
		default:
			t.Fatalf("unexpected signal %q", req.Signal)
			return nil, nil
		}
	})
	for _, tc := range []struct {
		signal, expected string
	}{{"metrics", `"requests_24h":27`}, {"logs", `"line":"site ready"`}} {
		t.Run(tc.signal, func(t *testing.T) {
			grant := telemetryTestGrant(config.audience, tc.signal, time.Now())
			out := serveAppTelemetry(t, handler, telemetryTestToken(t, grant, key, "key-one"), "")
			require.Equal(t, http.StatusOK, out.Code)
			require.Contains(t, out.Body.String(), `"state":"ok"`)
			require.Contains(t, out.Body.String(), tc.expected)
		})
	}
}

func TestAppTelemetryRejectsScopeAndCredentialFailuresBeforeQuery(t *testing.T) {
	t.Parallel()
	cfg, private := telemetryTestConfig(t)
	handler := cfg.handler(func(context.Context, string, string, connector.QueryRequest) (*connector.QueryResult, error) {
		t.Fatal("invalid app telemetry request reached the backend")
		return nil, nil
	})
	now := time.Now()
	_, unrelated, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	for _, tc := range []struct {
		name   string
		change func(*appTelemetryGrant)
	}{
		{"expired", func(g *appTelemetryGrant) {
			g.IssuedAt, g.ExpiresAt = jwt.NewNumericDate(now.Add(-time.Minute)), jwt.NewNumericDate(now.Add(-15*time.Second))
		}},
		{"future", func(g *appTelemetryGrant) {
			g.IssuedAt, g.ExpiresAt = jwt.NewNumericDate(now.Add(time.Minute)), jwt.NewNumericDate(now.Add(90*time.Second))
		}},
		{"overlong", func(g *appTelemetryGrant) { g.ExpiresAt = jwt.NewNumericDate(now.Add(time.Hour)) }},
		{"other audience", func(g *appTelemetryGrant) { g.Audience = jwt.ClaimStrings{"paprika-observability"} }},
		{"other issuer", func(g *appTelemetryGrant) { g.Issuer = "unknown-installation" }},
		{"tenant mismatch", func(g *appTelemetryGrant) { g.App = "tenant-two-storefront" }},
		{"unsupported signal", func(g *appTelemetryGrant) { g.Signal = "traces" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			grant := telemetryTestGrant(cfg.audience, "logs", now)
			tc.change(&grant)
			out := serveAppTelemetry(t, handler, telemetryTestToken(t, grant, private, "key-one"), "")
			require.Equal(t, http.StatusUnauthorized, out.Code)
		})
	}
	grant := telemetryTestGrant(cfg.audience, "logs", now)
	require.Equal(t, http.StatusUnauthorized, serveAppTelemetry(t, handler, "", "").Code)
	require.Equal(t, http.StatusUnauthorized, serveAppTelemetry(t, handler, telemetryTestToken(t, grant, unrelated, "key-one"), "").Code)
	require.Equal(t, http.StatusUnauthorized, serveAppTelemetry(t, handler, telemetryTestToken(t, grant, private, "key-removed"), "").Code)
	valid := telemetryTestToken(t, grant, private, "key-one")
	require.Equal(t, http.StatusBadRequest, serveAppTelemetry(t, handler, valid, "?app=another").Code)
}

func TestAppTelemetryChecksReturnedLabels(t *testing.T) {
	t.Parallel()
	cfg, key := telemetryTestConfig(t)
	for _, signal := range []string{"metrics", "logs"} {
		t.Run(signal, func(t *testing.T) {
			handler := cfg.handler(func(_ context.Context, _, _ string, req connector.QueryRequest) (*connector.QueryResult, error) {
				data := `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"tenant":"tenant-one","app":"tenant-one-billing","metric":"requests_24h"},"value":[1,"400"]}]}}`
				if signal == "logs" {
					data = fmt.Sprintf(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"tenant":"tenant-two","app":"tenant-two-storefront"},"values":[[%q,"private line"]]}]}}`,
						fmt.Sprint(req.Range.End.Add(-time.Second).UnixNano()))
				}
				return &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(data)}, nil
			})
			out := serveAppTelemetry(t, handler, telemetryTestToken(t, telemetryTestGrant(cfg.audience, signal, time.Now()), key, "key-one"), "")
			require.JSONEq(t, `{"state":"unavailable"}`, out.Body.String())
		})
	}
}

func TestAppTelemetryDoesNotUseAnUnconfiguredSignal(t *testing.T) {
	t.Parallel()
	cfg, key := telemetryTestConfig(t)
	cfg.logsProvider = ""
	handler := cfg.handler(func(context.Context, string, string, connector.QueryRequest) (*connector.QueryResult, error) {
		t.Fatal("a disabled signal reached the query backend")
		return nil, nil
	})
	out := serveAppTelemetry(t, handler, telemetryTestToken(t, telemetryTestGrant(cfg.audience, "logs", time.Now()), key, "key-one"), "")
	require.JSONEq(t, `{"state":"not_configured"}`, out.Body.String())
}

func TestAppOnlyProvidersAreUnavailableToGeneralReaders(t *testing.T) {
	t.Parallel()
	inner := &fakeBackend{providers: []ProviderInfo{
		{Name: "shared/traffic", Namespace: "shared"}, {Name: "shared/other", Namespace: "shared"},
	}}
	backend := &authorizedBackend{backend: inner, authorizer: &auth.AllowAllAuthorizer{}, appOnly: []string{"shared/traffic"}}
	ctx := auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "general-operator"})
	providers, err := backend.ListProviders(ctx)
	require.NoError(t, err)
	require.Equal(t, []ProviderInfo{{Name: "shared/other", Namespace: "shared"}}, providers)
	_, err = backend.Query(ctx, "shared/traffic", connector.QueryRequest{Signal: connector.SignalMetrics})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	_, err = backend.Explore(ctx, "shared/traffic", connector.ExploreRequest{Kind: connector.ExploreLabelValues})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Empty(t, inner.lastProvider)
}
