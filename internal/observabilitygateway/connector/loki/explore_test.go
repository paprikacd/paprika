package loki

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExploreLabelNames(t *testing.T) {
	t.Parallel()

	server, capture := newTestServer(t, http.StatusOK, `{"status":"success","data":["app","namespace","pod"]}`)
	res, err := Loki{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["app","namespace","pod"]}`, string(res.Data))
	require.Equal(t, "/loki/api/v1/labels", capture.path)
}

func TestExploreLabelValues(t *testing.T) {
	t.Parallel()

	server, capture := newTestServer(t, http.StatusOK, `{"status":"success","data":["api","worker"]}`)
	res, err := Loki{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelValues,
		Label:  "app",
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)
	require.JSONEq(t, `{"status":"success","data":["api","worker"]}`, string(res.Data))
	require.Equal(t, "/loki/api/v1/label/app/values", capture.path)
}

func TestExploreLabelValuesRequiresLabel(t *testing.T) {
	t.Parallel()

	res, err := Loki{}.Explore(context.Background(), connector.ExploreRequest{
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
		connector.ExploreMetricSeries,
		connector.ExploreTraceServices,
	} {
		res, err := Loki{}.Explore(context.Background(), connector.ExploreRequest{
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
	res, err := Loki{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:   connector.ExploreLabelNames,
		Config: endpointConfig(t, server.URL),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
}
