package prometheus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// newExploreServer returns an httptest server that routes each exploration
// API path to its canned response body, plus the last-request capture, so
// every kind can be exercised against one server without call-order
// coupling. A path absent from bodies answers 500.
func newExploreServer(t *testing.T, bodies map[string]string) (*httptest.Server, *requestCapture) {
	t.Helper()
	capture := &requestCapture{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capture.path = r.URL.Path
		capture.query = r.URL.Query()
		capture.auth = r.Header.Get("Authorization")
		body, ok := bodies[r.URL.Path]
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"error":"unexpected path"}`)
			return
		}
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server, capture
}

func TestExploreMetricNames(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/label/__name__/values": `{"status":"success","data":["up","go_goroutines","go_memstats_alloc_bytes","http_requests_total"]}`,
	})

	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Prefix: "go_",
		Limit:  1,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["go_goroutines"]}`, string(res.Data))
	require.Equal(t, "/api/v1/label/__name__/values", capture.path)
}

func TestExploreMetricNamesNoFilterPassesBackendDataThrough(t *testing.T) {
	t.Parallel()

	server, _ := newExploreServer(t, map[string]string{
		"/api/v1/label/__name__/values": `{"status":"success","data":["up","go_goroutines"]}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["up","go_goroutines"]}`, string(res.Data))
}

func TestExploreLabelNamesGlobal(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/labels": `{"status":"success","data":["instance","job"]}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["instance","job"]}`, string(res.Data))
	require.Equal(t, "/api/v1/labels", capture.path)
}

func TestExploreLabelNamesConstrainedToMetricUnionsSeriesLabels(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/series": `{"status":"success","data":[{"__name__":"up","job":"a","instance":"x"},{"__name__":"up","job":"b","instance":"y","extra":"z"}]}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Metric: "up",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["__name__","extra","instance","job"]}`, string(res.Data))
	require.Equal(t, "up", capture.query.Get("match[]"))
}

func TestExploreLabelValuesGlobal(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/label/job/values": `{"status":"success","data":["api","worker"]}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelValues,
		Label:  "job",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["api","worker"]}`, string(res.Data))
	require.Equal(t, "/api/v1/label/job/values", capture.path)
}

func TestExploreLabelValuesConstrainedToMetric(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/series": `{"status":"success","data":[{"job":"api"},{"job":"worker"},{"job":"api"}]}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelValues,
		Label:  "job",
		Metric: "up",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["api","worker"]}`, string(res.Data))
	require.Equal(t, "up", capture.query.Get("match[]"))
}

func TestExploreLabelValuesRequiresLabel(t *testing.T) {
	t.Parallel()

	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelValues,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.NotEmpty(t, res.Reason)
}

func TestExploreMetricMetadata(t *testing.T) {
	t.Parallel()

	server, capture := newExploreServer(t, map[string]string{
		"/api/v1/metadata": `{"status":"success","data":{"http_requests_total":[{"type":"counter","help":"Total HTTP requests.","unit":""}]}}`,
	})
	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricMetadata,
		Metric: "http_requests_total",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":{"http_requests_total":[{"type":"counter","help":"Total HTTP requests.","unit":""}]}}`, string(res.Data))
	require.Equal(t, "http_requests_total", capture.query.Get("metric"))
}

func TestExploreMetricMetadataRequiresMetric(t *testing.T) {
	t.Parallel()

	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreMetricMetadata,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreUnsupportedKind(t *testing.T) {
	t.Parallel()

	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreTraceServices,
		Config: endpointConfig(t, "http://localhost:1"),
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "not served")
}

func TestExploreBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"error":"boom"}`)
	}))
	t.Cleanup(broken.Close)

	res, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Config: endpointConfig(t, broken.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateError, res.State)
	require.NotEmpty(t, res.Reason)

	forbidden := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"unauthorized"}`)
	}))
	t.Cleanup(forbidden.Close)
	res, err = Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Config: endpointConfig(t, forbidden.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
}

func TestExploreBadConfigIsACallerError(t *testing.T) {
	t.Parallel()

	_, err := Prometheus{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreMetricNames,
		Config: json.RawMessage(`{"endpoint":"not a url at all ://"}`),
	})
	require.Error(t, err)
}
