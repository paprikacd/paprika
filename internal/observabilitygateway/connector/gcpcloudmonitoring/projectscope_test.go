package gcpcloudmonitoring

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestCallerCannotOverrideConfiguredProject(t *testing.T) {
	t.Parallel()
	for _, query := range []string{
		`project = "linked-project" AND metric.type="custom.googleapis.com/foo"`,
		`metric.type="custom.googleapis.com/foo" AND (project="linked-project" OR project="test-proj")`,
		`project = monitoring.regex.full_match(".*") AND metric.type="custom.googleapis.com/foo"`,
	} {
		result, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalMetrics, Query: query})
		require.ErrorIs(t, err, connector.ErrUnsupported)
		require.Equal(t, connector.StateNotAvailable, result.State)
		require.NotContains(t, result.Reason, "linked-project")
	}
}

func TestProjectLabelAndQuotedValueRemainUsableInsidePinnedProject(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, timeSeriesOK)
	query := `metric.type="custom.googleapis.com/foo" AND (metric.labels.note="project = \"linked\"" OR metric.labels.note="project") AND resource.labels.project="label-value"`
	result, err := New().Query(context.Background(), queryMetrics(testConfig(t, fake.server.URL), fakeServiceAccountCreds(t, fake.server.URL+"/token", "other-project"), func(req *connector.QueryRequest) {
		req.Query = query
	}))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	got := fake.last(t)
	require.Equal(t, "/v3/projects/test-proj/timeSeries", got.path)
	require.Equal(t, `project = "test-proj" AND (`+query+`)`, got.query.Get("filter"))
	require.Equal(t, "FULL", got.query.Get("view"))
}

func TestDescriptorPaginationKeepsConfiguredProjectSelector(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		require.Equal(t, "/v3/projects/test-proj/metricDescriptors", r.URL.Path)
		require.Equal(t, `project = "test-proj" AND (metric.type = starts_with("custom."))`, r.URL.Query().Get("filter"))
		if n == 1 {
			require.Empty(t, r.URL.Query().Get("pageToken"))
			fmt.Fprint(w, `{"metricDescriptors":[{"type":"custom.one"}],"nextPageToken":"next-page"}`)
		} else {
			require.Equal(t, "next-page", r.URL.Query().Get("pageToken"))
			fmt.Fprint(w, `{"metricDescriptors":[{"type":"custom.two"}]}`)
		}
	})
	result, err := CloudMonitoring{}.Explore(context.Background(), connector.ExploreRequest{
		Kind: connector.ExploreMetricNames, Prefix: "custom.", Config: testConfig(t, fake.server.URL),
		Credentials: fakeServiceAccountCreds(t, fake.server.URL+"/token", "other-project"),
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	require.EqualValues(t, 2, calls.Load())
	require.JSONEq(t, `{"status":"success","data":["custom.one","custom.two"]}`, string(result.Data))
}
