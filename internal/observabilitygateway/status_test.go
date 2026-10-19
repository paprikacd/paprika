package observabilitygateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	observabilityv1alpha1 "github.com/benebsworth/paprika/api/observability/v1alpha1"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// newProberClient builds the fake client the prober tests run against: the
// observability API plus core (credentials Secrets), status patches routed to
// the status subresource, and the patch counter proving write suppression.
func newProberClient(t *testing.T, patches *atomic.Int32, objs ...client.Object) client.Client {
	t.Helper()
	builder := fake.NewClientBuilder().
		WithScheme(newBackendScheme(t)).
		WithObjects(objs...).
		WithStatusSubresource(&observabilityv1alpha1.ObservabilityProvider{})
	if patches != nil {
		builder = builder.WithInterceptorFuncs(interceptor.Funcs{
			SubResourcePatch: func(ctx context.Context, c client.Client, subResourceName string, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
				if subResourceName == "status" {
					patches.Add(1)
				}
				return c.Status().Patch(ctx, obj, patch, opts...)
			},
		})
	}
	return builder.Build()
}

func getProviderStatus(t *testing.T, cl client.Client, namespace, name string) observabilityv1alpha1.ObservabilityProviderStatus {
	t.Helper()
	var got observabilityv1alpha1.ObservabilityProvider
	require.NoError(t, cl.Get(context.Background(), client.ObjectKey{Namespace: namespace, Name: name}, &got))
	return got.Status
}

func TestStatusProberWritesOKStatus(t *testing.T) {
	t.Parallel()

	// The probe runs the catalog's per-type health query against the real
	// prometheus connector — "up" is the cheapest expression the backend
	// accepts, exactly what probeQuery documents.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/api/v1/query", r.URL.Path)
		require.Equal(t, "up", r.URL.Query().Get("query"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	t.Cleanup(srv.Close)

	cl := newProberClient(t, nil, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
		cr.Spec.Config = runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"endpoint":%q}`, srv.URL))}
	}))

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	status := getProviderStatus(t, cl, "obs", "prom")
	require.Equal(t, string(connector.StateOK), status.State)
	require.Equal(t, int64(1), status.ObservedGeneration)
	cond := meta.FindStatusCondition(status.Conditions, "Ready")
	require.NotNil(t, cond)
	require.Equal(t, metav1.ConditionTrue, cond.Status)
	require.Equal(t, string(connector.StateOK), cond.Reason)
	require.Equal(t, int64(1), cond.ObservedGeneration)
}

func TestStatusProberForbiddenResultCarriesFixedSentence(t *testing.T) {
	t.Parallel()

	// A credential refusal is data, not an error: the result travels with the
	// httphelp fixed sentence and the raw backend body must never reach status.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"credential material detail"}`))
	}))
	t.Cleanup(srv.Close)

	cl := newProberClient(t, nil, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
		cr.Spec.Config = runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"endpoint":%q}`, srv.URL))}
	}))

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	status := getProviderStatus(t, cl, "obs", "prom")
	require.Equal(t, string(connector.StateForbidden), status.State)
	require.Equal(t, "the observability backend refused the supplied credentials", status.Reason)
	require.NotContains(t, status.Reason, "credential material detail")
	cond := meta.FindStatusCondition(status.Conditions, "Ready")
	require.NotNil(t, cond)
	require.Equal(t, metav1.ConditionFalse, cond.Status)
	require.Equal(t, string(connector.StateForbidden), cond.Reason)
	require.Equal(t, status.Reason, cond.Message)
}

func TestStatusProberConnectorErrorMapsOntoErrorState(t *testing.T) {
	t.Parallel()

	// The mock connector rejects an unknown config key with a bare error and
	// no result, which is the finishQuery contract this path exercises: an
	// error alone is classified onto a fixed-sentence state, and the raw
	// config detail stays out of the reason.
	cl := newProberClient(t, nil, providerCR("obs", "mock", connector.ProviderMock, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
		cr.Spec.Config = runtime.RawExtension{Raw: []byte(`{"bogusKey":1}`)}
	}))

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	status := getProviderStatus(t, cl, "obs", "mock")
	require.Equal(t, string(connector.StateError), status.State)
	require.Equal(t, reasonQueryFailed, status.Reason)
	require.NotContains(t, status.Reason, "bogusKey")
	cond := meta.FindStatusCondition(status.Conditions, "Ready")
	require.NotNil(t, cond)
	require.Equal(t, metav1.ConditionFalse, cond.Status)
}

func TestStatusProberMissingCredentialsSecret(t *testing.T) {
	t.Parallel()

	cl := newProberClient(t, nil, providerCR("obs", "prom", connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
		cr.Spec.CredentialsSecretRef = &observabilityv1alpha1.CredentialsSecretRef{Name: "nope"}
	}))

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	status := getProviderStatus(t, cl, "obs", "prom")
	require.Equal(t, string(connector.StateNotConfigured), status.State)
	require.Equal(t, reasonNotConfigured, status.Reason)
	cond := meta.FindStatusCondition(status.Conditions, "Ready")
	require.NotNil(t, cond)
	require.Equal(t, metav1.ConditionFalse, cond.Status)
}

func TestStatusProberSendsOnlyLabelledSameNamespaceCredentials(t *testing.T) {
	t.Parallel()

	// One backend stands in for an attacker-chosen endpoint: every
	// Authorization header the prober sends lands here.
	var mu sync.Mutex
	var received []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		received = append(received, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	t.Cleanup(srv.Close)

	secret := func(namespace, name, value string, labels map[string]string) *corev1.Secret {
		return &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, Labels: labels},
			Data:       map[string][]byte{"credentials": []byte(value)},
		}
	}
	provider := func(name string, ref observabilityv1alpha1.CredentialsSecretRef) *observabilityv1alpha1.ObservabilityProvider {
		return providerCR("obs", name, connector.ProviderPrometheus, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Generation = 1
			cr.Spec.Config = runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"endpoint":%q}`, srv.URL))}
			cr.Spec.CredentialsSecretRef = &ref
		})
	}
	cl := newProberClient(t, nil,
		secret("obs", "app-db-password", "unlabelled-key", nil),
		secret("other-team", "creds", "foreign-key", credentialsLabel()),
		secret("obs", "prom-creds", "control-key", credentialsLabel()),
		provider("unlabelled", observabilityv1alpha1.CredentialsSecretRef{Name: "app-db-password"}),
		provider("foreign", observabilityv1alpha1.CredentialsSecretRef{Namespace: "other-team", Name: "creds"}),
		provider("control", observabilityv1alpha1.CredentialsSecretRef{Name: "prom-creds"}),
	)

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{"Bearer control-key"}, received,
		"only the labelled, same-namespace credential may leave the gateway")
	for _, name := range []string{"unlabelled", "foreign"} {
		status := getProviderStatus(t, cl, "obs", name)
		require.Equal(t, string(connector.StateNotConfigured), status.State, name)
		require.Equal(t, reasonNotConfigured, status.Reason, name)
	}
	require.Equal(t, string(connector.StateOK), getProviderStatus(t, cl, "obs", "control").State)
}

func TestStatusProberUnknownProviderType(t *testing.T) {
	t.Parallel()

	// The CRD enum rejects an unknown type at admission; a CR that slipped
	// past the webhook anyway answers Error with the deployment-bug sentence,
	// as data — the probe cycle itself must not fail.
	cl := newProberClient(t, nil, providerCR("obs", "weird", "bogus", func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
	}))

	require.NoError(t, NewStatusProber(cl).runOnce(context.Background()))

	status := getProviderStatus(t, cl, "obs", "weird")
	require.Equal(t, string(connector.StateError), status.State)
	require.Equal(t, reasonProviderTypeUnavailable, status.Reason)
	cond := meta.FindStatusCondition(status.Conditions, "Ready")
	require.NotNil(t, cond)
	require.Equal(t, metav1.ConditionFalse, cond.Status)
}

func TestStatusProberSkipsUnchangedStatus(t *testing.T) {
	t.Parallel()

	var statusPatches atomic.Int32
	cl := newProberClient(t, &statusPatches, providerCR("obs", "mock", connector.ProviderMock, func(cr *observabilityv1alpha1.ObservabilityProvider) {
		cr.Generation = 1
	}))
	prober := NewStatusProber(cl)

	require.NoError(t, prober.runOnce(context.Background()))
	require.EqualValues(t, 1, statusPatches.Load(), "the first cycle must write the verdict")
	require.Equal(t, string(connector.StateOK), getProviderStatus(t, cl, "obs", "mock").State)

	require.NoError(t, prober.runOnce(context.Background()))
	require.EqualValues(t, 1, statusPatches.Load(), "an unchanged status must not be re-patched")
}

func TestStatusProberFansOutAcrossProviders(t *testing.T) {
	t.Parallel()

	objs := make([]client.Object, 0, 5)
	for i := 0; i < 5; i++ {
		objs = append(objs, providerCR("obs", fmt.Sprintf("mock-%d", i), connector.ProviderMock, func(cr *observabilityv1alpha1.ObservabilityProvider) {
			cr.Generation = 1
		}))
	}
	cl := newProberClient(t, nil, objs...)

	require.NoError(t, NewStatusProber(cl, WithProbeWorkers(2)).runOnce(context.Background()))

	for i := 0; i < 5; i++ {
		status := getProviderStatus(t, cl, "obs", fmt.Sprintf("mock-%d", i))
		require.Equal(t, string(connector.StateOK), status.State, "provider mock-%d", i)
		require.Equal(t, int64(1), status.ObservedGeneration, "provider mock-%d", i)
	}
}

func TestStatusProberRunReturnsOnCancellation(t *testing.T) {
	t.Parallel()

	cl := newProberClient(t, nil, providerCR("obs", "mock", connector.ProviderMock, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		NewStatusProber(cl, WithProbeInterval(time.Minute)).Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after context cancellation")
	}
}
