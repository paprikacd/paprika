package tempo

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExploreTraceServicesReadsServiceNameTagValues(t *testing.T) {
	t.Parallel()

	server, capture := newTestServer(t, http.StatusOK, `{"tagValues":["brandbrain-api","uptime-runner"]}`)
	res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreTraceServices,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"tagValues":["brandbrain-api","uptime-runner"]}`, string(res.Data))
	require.Equal(t, "/api/search/tag/service.name/values", capture.path)
}

func TestExploreLabelNamesReadsSearchTags(t *testing.T) {
	t.Parallel()

	server, capture := newTestServer(t, http.StatusOK, `{"tagNames":["service.name","http.response.status_code"]}`)
	res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"tagNames":["service.name","http.response.status_code"]}`, string(res.Data))
	require.Equal(t, "/api/search/tags", capture.path)
}

func TestExploreLabelValuesReadsSearchTagValues(t *testing.T) {
	t.Parallel()

	server, capture := newTestServer(t, http.StatusOK, `{"tagValues":["200","500"]}`)
	res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelValues,
		Label:  "http.response.status_code",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"tagValues":["200","500"]}`, string(res.Data))
	require.Equal(t, "/api/search/tag/http.response.status_code/values", capture.path)
}

func TestExploreLabelValuesRequiresTag(t *testing.T) {
	t.Parallel()

	res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreLabelValues,
	})
	require.Error(t, err)
	require.True(t, errors.Is(err, connector.ErrUnsupported))
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreMetricKindsAreNotServed(t *testing.T) {
	t.Parallel()

	for _, kind := range []connector.ExploreKind{
		connector.ExploreMetricNames,
		connector.ExploreMetricMetadata,
	} {
		res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
			Kind:   kind,
			Config: endpointConfig(t, "http://localhost:1"),
		})
		require.Error(t, err)
		require.True(t, errors.Is(err, connector.ErrUnsupported), "kind %q", kind)
		require.Equal(t, connector.StateNotAvailable, res.State)
	}
}

func TestExploreBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()

	server, _ := newTestServer(t, http.StatusUnauthorized, `{"error":"unauthorized"}`)
	res, err := Tempo{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreTraceServices,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
}
