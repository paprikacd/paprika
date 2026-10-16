package vultrmonitoring

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExploreMetricNames(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Prefix: "instance_bandwidth",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":[
		"instance_bandwidth_incoming_bytes",
		"instance_bandwidth_outgoing_bytes"
	]}`, string(res.Data))
}

func TestExploreLabelNames(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelNames,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["instance_id","label","region","status"]}`, string(res.Data))
}

func TestExploreLabelValuesEnumeratesLiveInstances(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelValues,
		Label:       "label",
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["core-node","worker-node"]}`, string(res.Data))
	queries, _ := fake.recordedRequests()
	require.Len(t, queries, 1)
}

func TestExploreLabelValuesForInstanceID(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelValues,
		Label:       "instance_id",
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["abc-1","abc-2"]}`, string(res.Data))
}

func TestExploreUnknownLabelIsNotAvailable(t *testing.T) {
	t.Parallel()

	fake := newFakeVultrAPI(t, cannedAccountBandwidth, cannedInstances, cannedInstanceBandwidth)
	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelValues,
		Label:       "zone",
		Config:      configFor(t, fake.srv.URL),
		Credentials: []byte("test-api-key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, reasonNotEnumerated, res.Reason)
	queries, _ := fake.recordedRequests()
	require.Empty(t, queries)
}

func TestExploreMetricMetadata(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricMetadata,
		Metric: MetricInstanceOutgoingBytes,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":{
		"instance_bandwidth_outgoing_bytes":[{"type":"counter","help":"Per-instance outgoing network bytes per day over the current billing period, assembled across every cloud-compute instance.","unit":"bytes"}]
	}}`, string(res.Data))
}

func TestExploreMetricMetadataUnknownMetric(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricMetadata,
		Metric: "cpu_usage",
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "cpu_usage")
}

func TestExploreMissingCredentialsReportsNotConfigured(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelValues,
		Label:  "label",
		Config: configFor(t, "http://localhost:1"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateNotConfigured, res.State)
	require.Equal(t, reasonCredentials, res.Reason)
}

func TestExploreUnsupportedKinds(t *testing.T) {
	t.Parallel()

	for _, kind := range []connector.ExploreKind{connector.ExploreTraceServices, "bogus"} {
		res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
			Kind:   kind,
			Config: configFor(t, "http://localhost:1"),
		})
		require.Error(t, err)
		require.True(t, errors.Is(err, connector.ErrUnsupported), "kind %q", kind)
		require.Equal(t, connector.StateNotAvailable, res.State)
	}
}

func TestExploreLabelValuesRequiresLabel(t *testing.T) {
	t.Parallel()

	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelValues,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	srv := newErrorServer(t)
	res, err := VultrMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelValues,
		Label:       "label",
		Config:      configFor(t, srv.URL),
		Credentials: []byte("key"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
	require.NotEmpty(t, res.Reason)
}

// newErrorServer answers every request 500 for the backend-error mapping
// tests.
func newErrorServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":"boom"}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}
