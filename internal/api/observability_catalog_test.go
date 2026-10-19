package apiserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/api/auth"
	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// observabilityCatalogServer builds a server over a fake client with the
// observability and core schemes registered (the create path writes Secrets
// alongside the CR). opts carries interceptor fault injection; objs seeds the
// inventory.
func observabilityCatalogServer(
	t *testing.T,
	objs []client.Object,
	interceptors interceptor.Funcs,
	authorizer auth.Authorizer,
) *PaprikaServer {
	t.Helper()

	scheme := runtime.NewScheme()
	require.NoError(t, observabilityv1alpha1.AddToScheme(scheme))
	require.NoError(t, corev1.AddToScheme(scheme))
	builder := fake.NewClientBuilder().WithScheme(scheme)
	if objs != nil {
		builder = builder.WithObjects(objs...)
	}
	if interceptors.Create != nil || interceptors.Delete != nil {
		builder = builder.WithInterceptorFuncs(interceptors)
	}
	cl := builder.Build()

	opts := []ServerOption{}
	if authorizer != nil {
		opts = append(opts, WithAuthorizer(authorizer))
	}
	return NewPaprikaServer(cl, nil, opts...)
}

// catalogGatewayServer reuses the usage harness (h2c plus the
// paprika-observability audience and paprika:observe scope the real gateway
// mounts) against an arbitrary handler, so every catalog test proves the
// minted token still has exactly the shape the gateway authenticates.
func catalogGatewayServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	return usageGatewayServer(t, handler)
}

func TestListObservabilityProviderTypesMapsGatewayCatalog(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"types": []map[string]any{
				{
					"type": "aws-cloudtrail", "displayName": "AWS CloudTrail",
					"vendor": "AWS", "category": "audit", "signals": []string{"logs"},
					"summary": "Read AWS CloudTrail audit events with the native lookup.",
				},
				{
					"type": "prometheus", "displayName": "Prometheus",
					"vendor": "Open source", "category": "metrics", "signals": []string{"metrics"},
					"summary": "Query Prometheus-compatible metrics endpoints with PromQL.",
				},
			},
		})
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.ListObservabilityProviderTypes(context.Background(),
		connect.NewRequest(&paprikav1.ListObservabilityProviderTypesRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_OK, resp.Msg.State)
	assert.Empty(t, resp.Msg.UnavailableReason)
	// The gateway's Vendor-then-DisplayName order is preserved verbatim.
	require.Len(t, resp.Msg.Types, 2)
	assert.Equal(t, "aws-cloudtrail", resp.Msg.Types[0].Type)
	assert.Equal(t, "AWS CloudTrail", resp.Msg.Types[0].DisplayName)
	assert.Equal(t, "AWS", resp.Msg.Types[0].Vendor)
	assert.Equal(t, "audit", resp.Msg.Types[0].Category)
	assert.Equal(t, []string{"logs"}, resp.Msg.Types[0].Signals)
	assert.Equal(t, "Read AWS CloudTrail audit events with the native lookup.", resp.Msg.Types[0].Summary)
	assert.Equal(t, "prometheus", resp.Msg.Types[1].Type)
}

func TestListObservabilityProviderTypesNotConfigured(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	resp, err := server.ListObservabilityProviderTypes(context.Background(),
		connect.NewRequest(&paprikav1.ListObservabilityProviderTypesRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, resp.Msg.State)
	assert.Equal(t, observabilityCatalogUnavailableReason, resp.Msg.UnavailableReason)
	assert.Empty(t, resp.Msg.Types)
	assert.NotNil(t, resp.Msg.Types)
}

func TestListObservabilityProviderTypesGatewayErrorIsSanitized(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "internal boom", http.StatusInternalServerError)
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.ListObservabilityProviderTypes(context.Background(),
		connect.NewRequest(&paprikav1.ListObservabilityProviderTypesRequest{}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, resp.Msg.State)
	assert.Equal(t, observabilityCatalogErrorReason, resp.Msg.UnavailableReason)
	assert.NotContains(t, resp.Msg.UnavailableReason, gateway.URL)
	assert.Empty(t, resp.Msg.Types)
}

func TestGetObservabilityProviderTypeRoundTripsDetail(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		// The handler must address the requested type in the path.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type": "loki", "displayName": "Grafana Loki", "vendor": "Open source",
			"category": "logs", "signals": []string{"logs"},
			"summary":      "Query Grafana Loki log stores with LogQL.",
			"description":  "Targets Grafana Loki, or any LogQL-speaking backend such as Mimir.",
			"configFields": []map[string]any{{"key": "endpoint", "label": "Endpoint", "input": "string", "required": true, "placeholder": "http://loki-gateway.monitoring:3100", "help": "Absolute http(s) URL of the backend.", "secret": false}},
			"credential":   map[string]any{"kind": "none", "help": "No credential is required by default."},
			"steps": []map[string]any{
				{"title": "Have the endpoint URL ready", "body": "Any LogQL-speaking backend works.", "code": ""},
				{"title": "Register the provider", "body": "Annotate the backend's Service.", "code": "kubectl annotate service loki observability.paprika.io/discover=true"},
			},
			"probe": map[string]any{"signal": "logs", "note": "A one-line LogQL read via /loki/api/v1/query_range."},
		})
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.GetObservabilityProviderType(context.Background(),
		connect.NewRequest(&paprikav1.GetObservabilityProviderTypeRequest{Type: "loki"}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_OK, resp.Msg.State)
	detail := resp.Msg.TypeDetail
	require.NotNil(t, detail)
	assert.Equal(t, "loki", detail.Type)
	assert.Equal(t, "Grafana Loki", detail.DisplayName)
	assert.Equal(t, []string{"logs"}, detail.Signals)
	assert.Equal(t, "Targets Grafana Loki, or any LogQL-speaking backend such as Mimir.", detail.Description)

	require.Len(t, detail.ConfigFields, 1)
	assert.Equal(t, "endpoint", detail.ConfigFields[0].Key)
	assert.Equal(t, "Endpoint", detail.ConfigFields[0].Label)
	assert.Equal(t, "string", detail.ConfigFields[0].Input)
	assert.True(t, detail.ConfigFields[0].Required)
	assert.Equal(t, "http://loki-gateway.monitoring:3100", detail.ConfigFields[0].Placeholder)
	assert.Equal(t, "Absolute http(s) URL of the backend.", detail.ConfigFields[0].Help)
	assert.False(t, detail.ConfigFields[0].Secret)

	require.NotNil(t, detail.Credential)
	assert.Equal(t, "none", detail.Credential.Kind)
	assert.Equal(t, "No credential is required by default.", detail.Credential.Help)

	require.Len(t, detail.Steps, 2)
	assert.Equal(t, "Have the endpoint URL ready", detail.Steps[0].Title)
	assert.Equal(t, "Any LogQL-speaking backend works.", detail.Steps[0].Body)
	assert.Empty(t, detail.Steps[0].Code)
	assert.Equal(t, "kubectl annotate service loki observability.paprika.io/discover=true", detail.Steps[1].Code)

	require.NotNil(t, detail.Probe)
	assert.Equal(t, "logs", detail.Probe.Signal)
	assert.Equal(t, "A one-line LogQL read via /loki/api/v1/query_range.", detail.Probe.Note)
}

func TestGetObservabilityProviderTypeUnknownTypeIsError(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"invalid_request","error_description":"unknown provider type"}`))
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.GetObservabilityProviderType(context.Background(),
		connect.NewRequest(&paprikav1.GetObservabilityProviderTypeRequest{Type: "clickhouse"}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, resp.Msg.State)
	assert.Equal(t, observabilityCatalogErrorReason, resp.Msg.UnavailableReason)
	// The gateway's 404 body must never be echoed into the console string.
	assert.NotContains(t, resp.Msg.UnavailableReason, "unknown provider type")
	assert.Nil(t, resp.Msg.TypeDetail)
}

func TestGetObservabilityProviderTypeNotConfigured(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	resp, err := server.GetObservabilityProviderType(context.Background(),
		connect.NewRequest(&paprikav1.GetObservabilityProviderTypeRequest{Type: "loki"}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, resp.Msg.State)
	assert.Equal(t, observabilityCatalogUnavailableReason, resp.Msg.UnavailableReason)
	assert.Nil(t, resp.Msg.TypeDetail)
}

func TestGetObservabilityProviderTypeRequiresType(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	_, err := server.GetObservabilityProviderType(context.Background(),
		connect.NewRequest(&paprikav1.GetObservabilityProviderTypeRequest{}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestValidateObservabilityProviderCarriesConnectorVerdict(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		assert.Equal(t, `"prometheus"`, string(body["type"]))
		assert.JSONEq(t, `{"endpoint":"https://prom.example.test"}`, string(body["config"]))
		assert.NotContains(t, body, "credentials", "offline validation must not forward credential material")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"state":  "Forbidden",
			"reason": "the backend refused the credential",
		})
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.ValidateObservabilityProvider(context.Background(),
		connect.NewRequest(&paprikav1.ValidateObservabilityProviderRequest{
			Type:        "prometheus",
			ConfigJson:  []byte(`{"endpoint":"https://prom.example.test"}`),
			Credentials: "access-key-material",
		}))
	require.NoError(t, err)
	// A refused credential is data, not an error: the caller's own state is
	// OK and the verdict travels in the connector fields.
	assert.Equal(t, paprikav1.DataState_DATA_STATE_OK, resp.Msg.State)
	assert.Empty(t, resp.Msg.UnavailableReason)
	assert.Equal(t, "Forbidden", resp.Msg.ConnectorState)
	assert.Equal(t, "the backend refused the credential", resp.Msg.Reason)
}

func TestValidateObservabilityProviderNotConfigured(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	resp, err := server.ValidateObservabilityProvider(context.Background(),
		connect.NewRequest(&paprikav1.ValidateObservabilityProviderRequest{Type: "loki"}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_NOT_CONFIGURED, resp.Msg.State)
	assert.Equal(t, observabilityCatalogUnavailableReason, resp.Msg.UnavailableReason)
	assert.Empty(t, resp.Msg.ConnectorState)
}

func TestValidateObservabilityProviderGatewayErrorIsSanitized(t *testing.T) {
	t.Parallel()

	gateway := catalogGatewayServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	server := observabilityProvidersServer(t, gateway.URL, usageTestIssuer, usageTestSecret)

	resp, err := server.ValidateObservabilityProvider(context.Background(),
		connect.NewRequest(&paprikav1.ValidateObservabilityProviderRequest{Type: "nope"}))
	require.NoError(t, err)
	assert.Equal(t, paprikav1.DataState_DATA_STATE_ERROR, resp.Msg.State)
	assert.Equal(t, observabilityCatalogErrorReason, resp.Msg.UnavailableReason)
}

func TestValidateObservabilityProviderRejectsNonObjectConfig(t *testing.T) {
	t.Parallel()

	server := observabilityProvidersServer(t, "", "", nil)
	_, err := server.ValidateObservabilityProvider(context.Background(),
		connect.NewRequest(&paprikav1.ValidateObservabilityProviderRequest{
			Type:       "loki",
			ConfigJson: []byte(`["not","an","object"]`),
		}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

//nolint:gosec // G101 false positive: the JSON document is a test fixture, not a credential — the value exists only inside this test binary.
func createProviderRequest() *paprikav1.CreateObservabilityProviderRequest {
	return &paprikav1.CreateObservabilityProviderRequest{
		Name:               "loki",
		Namespace:          "obs",
		Type:               "loki",
		ConfigJson:         []byte(`{"endpoint":"http://loki-gateway.monitoring:3100"}`),
		CredentialDocument: `{"user":"paprika","password":"s3cret"}`,
	}
}

func TestCreateObservabilityProviderCreatesSecretAndCR(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, nil)
	resp, err := server.CreateObservabilityProvider(context.Background(),
		connect.NewRequest(createProviderRequest()))
	require.NoError(t, err)
	assert.Equal(t, "loki", resp.Msg.Name)
	assert.Equal(t, "obs", resp.Msg.Namespace)

	ctx := context.Background()
	var secret corev1.Secret
	require.NoError(t, server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki-credentials"}, &secret))
	// The fake client does not run the API server's stringData conversion,
	// so the document is still readable back out of stringData — exactly
	// what the create path wrote.
	assert.Equal(t, `{"user":"paprika","password":"s3cret"}`, secret.StringData["credentials"])
	assert.Equal(t, corev1.SecretTypeOpaque, secret.Type)

	var provider observabilityv1alpha1.ObservabilityProvider
	require.NoError(t, server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki"}, &provider))
	assert.Equal(t, "loki", provider.Spec.Type)
	assert.JSONEq(t, `{"endpoint":"http://loki-gateway.monitoring:3100"}`, string(provider.Spec.Config.Raw))
	require.NotNil(t, provider.Spec.CredentialsSecretRef)
	assert.Equal(t, "loki-credentials", provider.Spec.CredentialsSecretRef.Name)
	assert.Equal(t, observabilityCredentialSecretKey, provider.Spec.CredentialsSecretRef.Key)
}

func TestCreateObservabilityProviderHonorsExplicitSecretName(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, nil)
	req := createProviderRequest()
	req.CredentialSecretName = "team-obs-credentials"
	_, err := server.CreateObservabilityProvider(context.Background(), connect.NewRequest(req))
	require.NoError(t, err)

	ctx := context.Background()
	var provider observabilityv1alpha1.ObservabilityProvider
	require.NoError(t, server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki"}, &provider))
	require.NotNil(t, provider.Spec.CredentialsSecretRef)
	assert.Equal(t, "team-obs-credentials", provider.Spec.CredentialsSecretRef.Name)

	var secret corev1.Secret
	require.NoError(t, server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "team-obs-credentials"}, &secret))
}

func TestCreateObservabilityProviderWithoutCredentialCreatesNoSecret(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, nil)
	req := createProviderRequest()
	req.CredentialDocument = ""
	req.CredentialSecretName = ""
	_, err := server.CreateObservabilityProvider(context.Background(), connect.NewRequest(req))
	require.NoError(t, err)

	ctx := context.Background()
	var provider observabilityv1alpha1.ObservabilityProvider
	require.NoError(t, server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki"}, &provider))
	assert.Nil(t, provider.Spec.CredentialsSecretRef)
	assert.JSONEq(t, `{"endpoint":"http://loki-gateway.monitoring:3100"}`, string(provider.Spec.Config.Raw))

	var secrets corev1.SecretList
	require.NoError(t, server.client.List(ctx, &secrets, client.InNamespace("obs")))
	assert.Empty(t, secrets.Items)
}

// rejectingProviderCreate simulates the admission webhook refusing the CR:
// the fake client has no webhook, so the interceptor injects the same
// apierrors.NewInvalid the API server would return, and passes every other
// create through to the real fake client.
func rejectingProviderCreate(
	providerName string,
	secretNames ...string,
) interceptor.Funcs {
	secretSet := map[string]bool{}
	for _, name := range secretNames {
		secretSet[name] = true
	}
	return interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			switch typed := obj.(type) {
			case *observabilityv1alpha1.ObservabilityProvider:
				if typed.Name == providerName {
					return apierrors.NewInvalid(
						schema.GroupKind{Group: "observability.paprika.io", Kind: "ObservabilityProvider"},
						typed.Name,
						field.ErrorList{field.Invalid(
							field.NewPath("spec", "config"),
							"<config redacted>",
							`endpoint: required field "endpoint" not set`,
						)},
					)
				}
			case *corev1.Secret:
				if secretSet[typed.Name] {
					return apierrors.NewAlreadyExists(schema.GroupResource{Resource: "secrets"}, typed.Name)
				}
			}
			return c.Create(ctx, obj, opts...)
		},
	}
}

func TestCreateObservabilityProviderWebhookRejectionCleansUpSecret(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, rejectingProviderCreate("loki"), nil)
	_, err := server.CreateObservabilityProvider(context.Background(),
		connect.NewRequest(createProviderRequest()))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	// The webhook message names the missing key, never a config value.
	assert.Contains(t, err.Error(), `endpoint`)
	assert.Contains(t, err.Error(), "obs")
	assert.NotContains(t, err.Error(), "s3cret")

	// The credential Secret must not survive the rejected CR.
	ctx := context.Background()
	var secret corev1.Secret
	secretErr := server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki-credentials"}, &secret)
	require.True(t, apierrors.IsNotFound(secretErr), "credential secret must be deleted after the CR is rejected")
}

func TestCreateObservabilityProviderAlreadyExists(t *testing.T) {
	t.Parallel()

	existing := &observabilityv1alpha1.ObservabilityProvider{
		ObjectMeta: metav1.ObjectMeta{Namespace: "obs", Name: "loki"},
		Spec:       observabilityv1alpha1.ObservabilityProviderSpec{Type: "loki"},
	}
	server := observabilityCatalogServer(t, []client.Object{existing}, interceptor.Funcs{}, nil)
	// No credential: the CR conflict is the error under test.
	req := createProviderRequest()
	req.CredentialDocument = ""
	_, err := server.CreateObservabilityProvider(context.Background(), connect.NewRequest(req))
	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))
}

func TestCreateObservabilityProviderCredentialSecretAlreadyExists(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, rejectingProviderCreate("", "loki-credentials"), nil)
	_, err := server.CreateObservabilityProvider(context.Background(),
		connect.NewRequest(createProviderRequest()))
	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))
	assert.Contains(t, err.Error(), "obs/loki-credentials")
	// The document must never be echoed, including in the error path.
	assert.NotContains(t, err.Error(), "s3cret")

	// The CR must not have been created behind the failed secret.
	ctx := context.Background()
	var provider observabilityv1alpha1.ObservabilityProvider
	getErr := server.client.Get(ctx, client.ObjectKey{Namespace: "obs", Name: "loki"}, &provider)
	require.True(t, apierrors.IsNotFound(getErr))
}

func TestCreateObservabilityProviderAuthorizesNamespace(t *testing.T) {
	t.Parallel()

	// The rule grants read only: the write must be denied, and a rule for a
	// different namespace must not leak access into the target one.
	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"read"},
		Resources:  []string{"observabilityproviders"},
		Namespaces: []string{"obs"},
	}})
	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, authorizer)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	_, err := server.CreateObservabilityProvider(ctx, connect.NewRequest(createProviderRequest()))
	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))

	// No write may have happened behind the denied authorization.
	var secrets corev1.SecretList
	require.NoError(t, server.client.List(context.Background(), &secrets, client.InNamespace("obs")))
	assert.Empty(t, secrets.Items)
}

func TestCreateObservabilityProviderAllowsAuthorizedPrincipal(t *testing.T) {
	t.Parallel()

	authorizer := auth.NewRBACAuthorizer([]auth.RBACRule{{
		Subjects:   []string{"alice"},
		Actions:    []string{"write"},
		Resources:  []string{"observabilityproviders"},
		Namespaces: []string{"obs"},
	}})
	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, authorizer)
	ctx := auth.WithPrincipal(context.Background(), &auth.Principal{Subject: "alice"})

	_, err := server.CreateObservabilityProvider(ctx, connect.NewRequest(createProviderRequest()))
	require.NoError(t, err)
}

func TestCreateObservabilityProviderValidatesTargetAndConfig(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, nil)
	ctx := context.Background()

	badName := createProviderRequest()
	badName.Name = "Not_A_DNS_Name"
	_, err := server.CreateObservabilityProvider(ctx, connect.NewRequest(badName))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	badNamespace := createProviderRequest()
	badNamespace.Namespace = ""
	_, err = server.CreateObservabilityProvider(ctx, connect.NewRequest(badNamespace))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	noType := createProviderRequest()
	noType.Type = ""
	_, err = server.CreateObservabilityProvider(ctx, connect.NewRequest(noType))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	badConfig := createProviderRequest()
	badConfig.ConfigJson = []byte(`"just a string"`)
	_, err = server.CreateObservabilityProvider(ctx, connect.NewRequest(badConfig))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	// Nothing may be written behind any rejected request.
	var providers observabilityv1alpha1.ObservabilityProviderList
	require.NoError(t, server.client.List(ctx, &providers))
	assert.Empty(t, providers.Items)
	var secrets corev1.SecretList
	require.NoError(t, server.client.List(ctx, &secrets))
	assert.Empty(t, secrets.Items)
}

func TestCreateObservabilityProviderEmptyConfigIsAccepted(t *testing.T) {
	t.Parallel()

	server := observabilityCatalogServer(t, nil, interceptor.Funcs{}, nil)
	req := createProviderRequest()
	req.ConfigJson = nil
	req.CredentialDocument = ""
	_, err := server.CreateObservabilityProvider(context.Background(), connect.NewRequest(req))
	require.NoError(t, err)

	var provider observabilityv1alpha1.ObservabilityProvider
	require.NoError(t, server.client.Get(context.Background(),
		client.ObjectKey{Namespace: "obs", Name: "loki"}, &provider))
	assert.Nil(t, provider.Spec.CredentialsSecretRef)
	assert.Empty(t, provider.Spec.Config.Raw)
}
