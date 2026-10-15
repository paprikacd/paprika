package gcpcloudlogging

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// envelopeData decodes the {"status":"success","data":[...]} envelope the
// exploration kinds answer in.
type envelopeData struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

func logMetricsOK(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"metrics":[
		{"name":"projects/test-proj/metrics/error_count","filter":"severity>=ERROR","metricDescriptor":{"name":"projects/test-proj/metricDescriptors/logging.googleapis.com/user/error_count","type":"logging.googleapis.com/user/error_count"}},
		{"name":"projects/test-proj/metrics/latency_high","filter":"textPayload: latency","metricDescriptor":{"name":"projects/test-proj/metricDescriptors/logging.googleapis.com/user/latency_high","type":"logging.googleapis.com/user/latency_high"}}
	]}`)
}

func TestExploreMetricNamesRoundTrip(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, logMetricsOK)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudLogging{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      testConfig(t, fake.server.URL),
		Credentials: creds,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// Resource names reduce to the short metric IDs an operator writes
	// into a filter, sorted in the envelope.
	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{"error_count", "latency_high"}, decoded.Data)

	got := fake.last(t)
	require.Equal(t, http.MethodGet, got.method)
	require.Equal(t, "/v2/projects/test-proj/metrics", got.path)
	require.Equal(t, "Bearer test-token", got.auth)
}

func TestExploreUnsupportedKind(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, logMetricsOK)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudLogging{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreLabelNames,
		Config:      testConfig(t, fake.server.URL),
		Credentials: creds,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreForbidden(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":"detail never surfaces"}`)
	})
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudLogging{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      testConfig(t, fake.server.URL),
		Credentials: creds,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotContains(t, res.Reason, "detail never surfaces")
	require.Nil(t, res.Data)
}
