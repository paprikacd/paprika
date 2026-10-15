package awsxray

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// envelopeData decodes the {"status":"success","data":[...]} envelope the
// exploration kinds answer in.
type envelopeData struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

func TestExploreTraceServicesRoundTrip(t *testing.T) {
	t.Parallel()
	var pages []json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		pages = append(pages, json.RawMessage("{}"))
		w.Header().Set("Content-Type", "application/json")
		switch len(pages) {
		case 1:
			fmt.Fprint(w, `{"Services":[{"Name":"api","Type":"AWS::ECS::Service"},{"Name":"db","Type":"AWS::RDS::DBInstance"}],"NextToken":"more"}`)
		default:
			fmt.Fprint(w, `{"Services":[{"Name":"api","Type":"AWS::ECS::Service"},{"Name":"queue","Type":"AWS::SQS::Queue"}]}`)
		}
	}))
	t.Cleanup(server.Close)

	res, err := XRay{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreTraceServices,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// The union across both pages is sorted and deduplicated.
	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{"api", "db", "queue"}, decoded.Data)
	require.Len(t, pages, 2)
}

func TestExploreTraceServicesWindow(t *testing.T) {
	t.Parallel()
	server, capture := newTestServer(t, http.StatusOK,
		`{"Services":[{"Name":"api","Type":"AWS::ECS::Service"}]}`)

	before := time.Now()
	res, err := XRay{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreTraceServices,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	require.Equal(t, "/ServiceGraph", capture.path)
	var sent struct {
		StartTime float64
		EndTime   float64
	}
	require.NoError(t, json.Unmarshal(capture.body, &sent))
	// GetServiceGraph requires both bounds: the connector passes a trailing
	// thirty-minute window ending at the call.
	require.InDelta(t, exploreWindow.Seconds(), sent.EndTime-sent.StartTime, 1)
	require.GreaterOrEqual(t, sent.EndTime, float64(before.Add(-time.Minute).Unix()))
}

func TestExploreUnsupportedKind(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusOK, `{"Services":[]}`)

	res, err := XRay{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreMetricNames,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
}

func TestExploreForbidden(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, http.StatusForbidden,
		`{"__type":"AccessDeniedException","message":"denied detail"}`)

	res, err := XRay{}.Explore(context.Background(), connector.ExploreRequest{
		Kind:        connector.ExploreTraceServices,
		Config:      queryConfig(t, server.URL),
		Credentials: testCredentials,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotContains(t, res.Reason, "denied detail")
	require.Nil(t, res.Data)
}
