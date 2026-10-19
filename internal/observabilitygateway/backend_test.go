package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// newBackendScheme registers everything the backend reads: core (Secrets)
// plus the observability API.
func newBackendScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, observabilityv1alpha1.AddToScheme(s))
	return s
}

func providerCR(namespace, name, providerType string, mutate func(*observabilityv1alpha1.ObservabilityProvider)) *observabilityv1alpha1.ObservabilityProvider {
	cr := &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name},
		Spec:       observabilityv1alpha1.ObservabilityProviderSpec{Type: providerType},
	}
	if mutate != nil {
		mutate(cr)
	}
	return cr
}

func TestListProvidersMapsCRs(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(
		providerCR("obs", "metrics-main", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Status.State = string(connector.StateOK)
			cr.Status.Reason = "ready"
		}),
		providerCR("obs", "logs-main", connector.ProviderLoki, nil),
	).Build()

	infos, err := NewBackend(cl).ListProviders(context.Background())
	require.NoError(t, err)
	require.Len(t, infos, 2)

	byName := make(map[string]ProviderInfo, len(infos))
	for _, info := range infos {
		byName[info.Name] = info
	}

	// Status fields map through verbatim.
	prom := byName["obs/metrics-main"]
	require.Equal(t, ProviderInfo{
		Name:      "obs/metrics-main",
		Namespace: "obs",
		Type:      connector.ProviderPrometheus,
		State:     string(connector.StateOK),
		Reason:    "ready",
	}, prom)

	// Absent status fields stay empty strings — never invented.
	loki := byName["obs/logs-main"]
	require.Equal(t, "obs/logs-main", loki.Name)
	require.Equal(t, connector.ProviderLoki, loki.Type)
	require.Empty(t, loki.State)
	require.Empty(t, loki.Reason)
}

func TestListProvidersEmpty(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()
	infos, err := NewBackend(cl).ListProviders(context.Background())
	require.NoError(t, err)
	require.NotNil(t, infos)
	require.Empty(t, infos)
}

// stubConnector captures the request it is handed and replays a canned
// result, so credential-resolution and result-mapping behaviour can be
// asserted without a live backend.
type stubConnector struct {
	result *connector.QueryResult
	err    error
	gotReq connector.QueryRequest
	gotCtx context.Context
}

func (s *stubConnector) Descriptor() connector.Descriptor {
	return connector.Descriptor{Name: "stub", Signals: []connector.Signal{connector.SignalMetrics}}
}

func (s *stubConnector) ValidateConfig(json.RawMessage) error { return nil }

func (s *stubConnector) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	s.gotCtx = ctx
	s.gotReq = req
	return s.result, s.err
}

func newStubBackend(t *testing.T, objects ...runtime.Object) (*k8sBackend, *stubConnector) {
	t.Helper()
	stub := &stubConnector{result: &connector.QueryResult{State: connector.StateOK, Data: json.RawMessage(`{"ok":true}`)}}
	// The fake tracker sets ResourceVersion on its input objects. Give each
	// backend private fixtures so parallel cases can safely reuse templates.
	fixtures := make([]runtime.Object, len(objects))
	for i, object := range objects {
		fixtures[i] = object.DeepCopyObject()
	}
	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithRuntimeObjects(fixtures...).Build()
	return &k8sBackend{
		client: cl,
		newConnector: func(providerType string) (connector.Connector, error) {
			require.Equal(t, connector.ProviderPrometheus, providerType)
			return stub, nil
		},
	}, stub
}

func TestQueryHappyPathAgainstTestServer(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/v1/query_range", r.URL.Path)
		require.Equal(t, "up", r.URL.Query().Get("query"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	t.Cleanup(srv.Close)

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(
		providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Spec.Config = runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"endpoint":%q}`, srv.URL))}
		}),
	).Build()

	result, err := NewBackend(cl).Query(context.Background(), "obs/prom", connector.QueryRequest{
		Signal: connector.SignalMetrics,
		Query:  "up",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	require.JSONEq(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`, string(result.Data))
}

func TestQueryProviderReferenceValidation(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()
	b := NewBackend(cl)

	for _, provider := range []string{"noslash", "/name", "namespace/"} {
		_, err := b.Query(context.Background(), provider, connector.QueryRequest{})
		require.Error(t, err)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "provider %q", provider)
	}
}

func TestQueryProviderNotFound(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()
	_, err := NewBackend(cl).Query(context.Background(), "obs/missing", connector.QueryRequest{})
	require.Error(t, err)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestQueryUnknownProviderType(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(
		providerCR("obs", "weird", "bogus", nil),
	).Build()
	_, err := NewBackend(cl).Query(context.Background(), "obs/weird", connector.QueryRequest{})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestQueryCredentialsResolution(t *testing.T) {
	t.Parallel()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: "obs", Name: "creds", Labels: credentialsLabel()},
		Data: map[string][]byte{
			"credentials": []byte("default-key"),
			"other":       []byte("other-key"),
		},
	}
	crossNSSecret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: "creds-ns", Name: "creds", Labels: credentialsLabel()},
		Data:       map[string][]byte{"token": []byte("cross-ns-key")},
	}

	tests := []struct {
		name      string
		mutate    func(*observabilityv1alpha1.ObservabilityProvider)
		authorize bool
		wantCreds []byte
	}{
		{
			name:      "nil ref means no credentials and no lookup",
			mutate:    nil,
			wantCreds: nil,
		},
		{
			name: "defaults resolve to the CR namespace and the credentials key",
			mutate: func(cr *observabilityv1alpha1.ObservabilityProvider) {
				cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "creds"}
			},
			wantCreds: []byte("default-key"),
		},
		{
			name: "explicit namespace and key are honored",
			mutate: func(cr *observabilityv1alpha1.ObservabilityProvider) {
				cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{
					Name:      "creds",
					Namespace: "creds-ns",
					Key:       "token",
				}
			},
			authorize: true,
			wantCreds: []byte("cross-ns-key"),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			b, stub := newStubBackend(t, secret, crossNSSecret,
				providerCR("obs", "prom", connector.ProviderPrometheus, tt.mutate))
			ctx := context.Background()
			if tt.authorize {
				b.credentialAuthorizer = &auth.AllowAllAuthorizer{}
				ctx = auth.WithPrincipal(ctx, &auth.Principal{Subject: "reader"})
			}
			result, err := b.Query(ctx, "obs/prom", connector.QueryRequest{
				Signal: connector.SignalMetrics,
				Query:  "up",
			})
			require.NoError(t, err)
			require.Equal(t, connector.StateOK, result.State)
			require.Equal(t, "up", stub.gotReq.Query)
			require.Equal(t, tt.wantCreds, stub.gotReq.Credentials)
		})
	}
}

func credentialsLabel() map[string]string {
	return map[string]string{observabilityv1alpha1.CredentialsSecretLabel: "true"}
}

func TestQueryRefusesUnlabelledCredentialsSecret(t *testing.T) {
	t.Parallel()

	for name, labels := range map[string]map[string]string{
		"no label":    nil,
		"wrong value": {observabilityv1alpha1.CredentialsSecretLabel: "false"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Namespace: "obs", Name: "app-token", Labels: labels},
				Data:       map[string][]byte{"credentials": []byte("never-send-this")},
			}
			b, stub := newStubBackend(t, secret, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
				cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "app-token"}
			}))
			_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
			require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
			require.Contains(t, err.Error(), "obs/app-token is not labelled "+observabilityv1alpha1.CredentialsSecretLabel+"=true")
			require.NotContains(t, err.Error(), "never-send-this")
			require.Nil(t, stub.gotCtx, "an unlabelled Secret must never reach a connector")
		})
	}
}

func TestQueryRefusesCrossNamespaceCredentialsWithoutAuthorizer(t *testing.T) {
	t.Parallel()

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Namespace: "other-team", Name: "creds", Labels: credentialsLabel()},
		Data:       map[string][]byte{"credentials": []byte("other-team-key")},
	}
	b, stub := newStubBackend(t, secret, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Namespace: "other-team", Name: "creds"}
	}))
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Nil(t, stub.gotCtx, "no caller can be authorized for another namespace's Secret")
}

func TestQueryCredentialsSecretNotFound(t *testing.T) {
	t.Parallel()

	b, _ := newStubBackend(t, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "nope"}
	}))
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
	require.Error(t, err)
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	// The message names the secret location only — never key material.
	require.Contains(t, err.Error(), "credentials secret obs/nope not found")
}

func TestQueryRequestPassesThroughToConnector(t *testing.T) {
	t.Parallel()

	start := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	end := time.Now().UTC().Truncate(time.Second)

	b, stub := newStubBackend(t, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Spec.Config = runtime.RawExtension{Raw: []byte(`{"endpoint":"http://prometheus:9090"}`)}
	}))
	_, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{
		Signal:  connector.SignalMetrics,
		Query:   "up",
		TraceID: "ignored-for-metrics",
		Range:   connector.TimeRange{Start: start, End: end},
		Limit:   25,
	})
	require.NoError(t, err)
	require.Equal(t, connector.SignalMetrics, stub.gotReq.Signal)
	require.Equal(t, "up", stub.gotReq.Query)
	require.Equal(t, connector.TimeRange{Start: start, End: end}, stub.gotReq.Range)
	require.Equal(t, 25, stub.gotReq.Limit)
	// Config travels from the CR, not from the caller's request.
	require.JSONEq(t, `{"endpoint":"http://prometheus:9090"}`, string(stub.gotReq.Config))
}

func TestQuerySentinelMapping(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		err        error
		wantState  connector.State
		wantReason string
	}{
		{
			name:       "forbidden",
			err:        fmt.Errorf("wrapped: %w", connector.ErrForbidden),
			wantState:  connector.StateForbidden,
			wantReason: reasonForbidden,
		},
		{
			name:       "not configured",
			err:        fmt.Errorf("wrapped: %w", connector.ErrNotConfigured),
			wantState:  connector.StateNotConfigured,
			wantReason: reasonNotConfigured,
		},
		{
			name:       "unsupported shape",
			err:        fmt.Errorf("wrapped: %w", connector.ErrUnsupported),
			wantState:  connector.StateNotAvailable,
			wantReason: reasonShapeSupported,
		},
		{
			name:       "path not available",
			err:        fmt.Errorf("wrapped: %w", connector.ErrNotAvailable),
			wantState:  connector.StateNotAvailable,
			wantReason: reasonNotAvailable,
		},
		{
			name:       "unrecognized failure",
			err:        errors.New("connection reset by peer"),
			wantState:  connector.StateError,
			wantReason: reasonQueryFailed,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			b, stub := newStubBackend(t, providerCR("obs", "prom", connector.ProviderPrometheus, nil))
			stub.result = nil
			stub.err = tt.err

			result, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
			require.NoError(t, err)
			require.NotNil(t, result)
			require.Equal(t, tt.wantState, result.State)
			require.Equal(t, tt.wantReason, result.Reason)
			// Raw error text must never leak into the reason.
			require.NotContains(t, result.Reason, "connection reset")
		})
	}
}

func TestQueryUnsupportedDualReturnPrefersResult(t *testing.T) {
	t.Parallel()

	dual := &connector.QueryResult{State: connector.StateNotAvailable, Reason: reasonShapeSupported}
	b, stub := newStubBackend(t, providerCR("obs", "prom", connector.ProviderPrometheus, nil))
	stub.result = dual
	stub.err = fmt.Errorf("%w: traces on a metrics connector", connector.ErrUnsupported)

	result, err := b.Query(context.Background(), "obs/prom", connector.QueryRequest{Signal: connector.SignalMetrics, Query: "up"})
	// The dual return logs the error and hands back the result as-is.
	require.NoError(t, err)
	require.Same(t, dual, result)
}

func TestNewConnectorRegistry(t *testing.T) {
	t.Parallel()

	reg := NewConnectorRegistry()
	require.Equal(t, []string{
		"aws-cloudtrail",
		"aws-cloudwatch-logs",
		"aws-cloudwatch-metrics",
		"aws-xray",
		"gcp-cloudlogging",
		"gcp-cloudmonitoring",
		"gcp-cloudtrace",
		"loki",
		"mock",
		"otlp",
		"prometheus",
		"tempo",
		"vultr-monitoring",
	}, reg.Names())
}

// stubExplorer is a stubConnector that also implements connector.Explorer,
// capturing the Explore request it is handed.
type stubExplorer struct {
	stubConnector
	exploreResult *connector.ExploreResult
	exploreErr    error
	gotExplore    connector.ExploreRequest
}

func (s *stubExplorer) Explore(_ context.Context, req connector.ExploreRequest) (*connector.ExploreResult, error) {
	s.gotExplore = req
	return s.exploreResult, s.exploreErr
}

func newExploreBackend(t *testing.T, providerType string, conn connector.Connector, objects ...runtime.Object) *k8sBackend {
	t.Helper()
	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithRuntimeObjects(objects...).Build()
	return &k8sBackend{
		client: cl,
		newConnector: func(gotType string) (connector.Connector, error) {
			require.Equal(t, providerType, gotType)
			return conn, nil
		},
	}
}

func TestExploreHappyPathPassesThroughToConnector(t *testing.T) {
	t.Parallel()

	stub := &stubExplorer{exploreResult: &connector.ExploreResult{
		State: connector.StateOK,
		Data:  json.RawMessage(`{"status":"success","data":["up"]}`),
	}}
	b := newExploreBackend(t, connector.ProviderPrometheus, stub,
		providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Spec.Config = runtime.RawExtension{Raw: []byte(`{"endpoint":"http://prom:9090"}`)}
		}),
	)

	result, err := b.Explore(context.Background(), "obs/prom", connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Prefix: "up",
		Limit:  10,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	require.JSONEq(t, `{"status":"success","data":["up"]}`, string(result.Data))
	// The full request travels into the connector; config comes from the CR.
	require.Equal(t, connector.ExploreMetricNames, stub.gotExplore.Kind)
	require.Equal(t, "up", stub.gotExplore.Prefix)
	require.Equal(t, 10, stub.gotExplore.Limit)
	require.JSONEq(t, `{"endpoint":"http://prom:9090"}`, string(stub.gotExplore.Config))
}

func TestExploreConnectorWithoutExplorationAnswersNotAvailable(t *testing.T) {
	t.Parallel()

	// stubConnector does not implement connector.Explorer: the backend must
	// answer StateNotAvailable as data, not as a caller-bug error.
	b := newExploreBackend(t, connector.ProviderOTLP, &stubConnector{},
		providerCR("obs", "otlp", connector.ProviderOTLP, nil),
	)
	result, err := b.Explore(context.Background(), "obs/otlp", connector.ExploreRequest{
		Kind: connector.ExploreMetricNames,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotAvailable, result.State)
	require.Contains(t, result.Reason, "does not support schema exploration")
}

func TestExploreProviderReferenceValidation(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()
	b := NewBackend(cl)
	for _, provider := range []string{"noslash", "/name", "namespace/"} {
		_, err := b.Explore(context.Background(), provider, connector.ExploreRequest{})
		require.Error(t, err)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "provider %q", provider)
	}
}

func TestExploreProviderNotFound(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).Build()
	_, err := NewBackend(cl).Explore(context.Background(), "obs/missing", connector.ExploreRequest{})
	require.Error(t, err)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestExploreUnknownProviderType(t *testing.T) {
	t.Parallel()

	cl := fake.NewClientBuilder().WithScheme(newBackendScheme(t)).WithObjects(
		providerCR("obs", "weird", "bogus", nil),
	).Build()
	_, err := NewBackend(cl).Explore(context.Background(), "obs/weird", connector.ExploreRequest{})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestExploreErrorMapping(t *testing.T) {
	t.Parallel()

	t.Run("dual result and error prefers the result", func(t *testing.T) {
		dual := &connector.ExploreResult{State: connector.StateNotAvailable, Reason: reasonShapeSupported}
		stub := &stubExplorer{exploreResult: dual, exploreErr: fmt.Errorf("%w: traces on a metrics connector", connector.ErrUnsupported)}
		b := newExploreBackend(t, connector.ProviderPrometheus, stub,
			providerCR("obs", "prom", connector.ProviderPrometheus, nil),
		)
		result, err := b.Explore(context.Background(), "obs/prom", connector.ExploreRequest{Kind: connector.ExploreMetricNames})
		require.NoError(t, err)
		require.Same(t, dual, result)
	})

	t.Run("error alone maps onto a fixed-sentence state", func(t *testing.T) {
		stub := &stubExplorer{exploreErr: fmt.Errorf("%w: bad document", connector.ErrNotConfigured)}
		b := newExploreBackend(t, connector.ProviderPrometheus, stub,
			providerCR("obs", "prom", connector.ProviderPrometheus, nil),
		)
		result, err := b.Explore(context.Background(), "obs/prom", connector.ExploreRequest{Kind: connector.ExploreMetricNames})
		require.NoError(t, err)
		require.Equal(t, connector.StateNotConfigured, result.State)
		require.NotEmpty(t, result.Reason)
	})
}
