package gcpcloudmonitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestExplorePaginationBoundFailsInsteadOfClaimingComplete(t *testing.T) {
	t.Parallel()
	for _, repeated := range []bool{false, true} {
		t.Run(fmt.Sprint(repeated), func(t *testing.T) {
			t.Parallel()
			var calls atomic.Int32
			fake := newFakeGCP(t, false, func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				token := "private-repeated-token"
				if !repeated {
					token = fmt.Sprintf("private-page-%d", n)
				}
				fmt.Fprintf(w, `{"metricDescriptors":[],"nextPageToken":%q}`, token)
			})
			res, err := CloudMonitoring{}.Explore(context.Background(), connector.ExploreRequest{Kind: connector.ExploreMetricNames, Config: testConfig(t, fake.server.URL), Credentials: fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")})
			require.NoError(t, err)
			require.Equal(t, connector.StateError, res.State)
			require.Nil(t, res.Data)
			require.NotContains(t, res.Reason, "private")
			if repeated {
				require.EqualValues(t, 2, calls.Load())
			} else {
				require.EqualValues(t, exploreMaxPages, calls.Load())
			}
		})
	}
}

// envelopeData decodes the {"status":"success","data":[...]} envelope the
// exploration kinds answer in.
type envelopeData struct {
	Status string   `json:"status"`
	Data   []string `json:"data"`
}

func exploreRequest(cfg json.RawMessage, creds json.RawMessage, kind connector.ExploreKind, mutate func(*connector.ExploreRequest)) connector.ExploreRequest {
	req := connector.ExploreRequest{
		Kind:        kind,
		Config:      cfg,
		Credentials: creds,
	}
	if mutate != nil {
		mutate(&req)
	}
	return req
}

func descriptorsPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"metricDescriptors":[
		{"name":"projects/test-proj/metricDescriptors/custom.googleapis.com/foo","type":"custom.googleapis.com/foo","description":"foo desc","unit":"1","metricKind":"GAUGE","valueType":"DOUBLE","labels":[{"key":"env","valueDescription":"environment"},{"key":"pod","valueDescription":"pod name"}]},
		{"name":"projects/test-proj/metricDescriptors/custom.googleapis.com/bar","type":"custom.googleapis.com/bar","labels":[{"key":"env","valueDescription":"environment"},{"key":"region","valueDescription":"region"}]},
		{"name":"projects/test-proj/metricDescriptors/logging.googleapis.com/baz","type":"logging.googleapis.com/baz","labels":[{"key":"zone","valueDescription":"zone"}]}
	]}`)
}

// customOnlyPage is the page a real backend answers for the
// starts_with("custom.") filters these tests send: only the custom.*
// descriptors.
func customOnlyPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"metricDescriptors":[
		{"name":"projects/test-proj/metricDescriptors/custom.googleapis.com/foo","type":"custom.googleapis.com/foo","description":"foo desc","unit":"1","metricKind":"GAUGE","valueType":"DOUBLE","labels":[{"key":"env","valueDescription":"environment"},{"key":"pod","valueDescription":"pod name"}]},
		{"name":"projects/test-proj/metricDescriptors/custom.googleapis.com/bar","type":"custom.googleapis.com/bar","labels":[{"key":"env","valueDescription":"environment"},{"key":"region","valueDescription":"region"}]}
	]}`)
}

// barOnlyPage is the page a real backend answers for the exact
// metric.type = "custom.googleapis.com/bar" filter.
func barOnlyPage(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"metricDescriptors":[
		{"name":"projects/test-proj/metricDescriptors/custom.googleapis.com/bar","type":"custom.googleapis.com/bar","labels":[{"key":"env","valueDescription":"environment"},{"key":"region","valueDescription":"region"}]}
	]}`)
}

func TestExploreMetricNamesPrefixFilterOnWire(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, customOnlyPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreMetricNames,
		func(req *connector.ExploreRequest) { req.Prefix = "custom." }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// The backend's own prefix mechanism carries the filter; the union is
	// sorted and limited client-side.
	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "success", decoded.Status)
	require.Equal(t, []string{"custom.googleapis.com/bar", "custom.googleapis.com/foo"}, decoded.Data)

	got := fake.last(t)
	require.Equal(t, "/v3/projects/test-proj/metricDescriptors", got.path)
	require.Equal(t, `project = "test-proj" AND (metric.type = starts_with("custom."))`, got.query.Get("filter"))
}

func TestExploreMetricNamesNoPrefix(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, descriptorsPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreMetricNames, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{
		"custom.googleapis.com/bar",
		"custom.googleapis.com/foo",
		"logging.googleapis.com/baz",
	}, decoded.Data)

	require.Equal(t, `project = "test-proj"`, fake.last(t).query.Get("filter"))
}

func TestExploreLabelNamesUnion(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, customOnlyPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreLabelNames,
		func(req *connector.ExploreRequest) { req.Prefix = "custom." }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"env", "pod", "region"}, decoded.Data)
}

func TestExploreLabelNamesScopedToMetric(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, barOnlyPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreLabelNames,
		func(req *connector.ExploreRequest) { req.Metric = "custom.googleapis.com/bar" }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	var decoded envelopeData
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, []string{"env", "region"}, decoded.Data)

	require.Equal(t, `project = "test-proj" AND (metric.type = "custom.googleapis.com/bar")`, fake.last(t).query.Get("filter"))
}

func TestExploreMetricMetadataRoundTrip(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, descriptorsPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreMetricMetadata,
		func(req *connector.ExploreRequest) { req.Metric = "custom.googleapis.com/foo" }))
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, res.State)

	// The descriptor passes through untouched: native descriptor JSON with
	// type, description, unit, metricKind and valueType.
	var decoded struct {
		Type        string `json:"type"`
		Description string `json:"description"`
		Unit        string `json:"unit"`
		MetricKind  string `json:"metricKind"`
		ValueType   string `json:"valueType"`
	}
	require.NoError(t, json.Unmarshal(res.Data, &decoded))
	require.Equal(t, "custom.googleapis.com/foo", decoded.Type)
	require.Equal(t, "foo desc", decoded.Description)
	require.Equal(t, "1", decoded.Unit)
	require.Equal(t, "GAUGE", decoded.MetricKind)
	require.Equal(t, "DOUBLE", decoded.ValueType)
}

func TestExploreLabelValuesNotAvailable(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, descriptorsPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreLabelValues,
		func(req *connector.ExploreRequest) { req.Label = "env" }))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Contains(t, res.Reason, "label values")
}

func TestExploreUnsupportedKinds(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, descriptorsPage)
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreTraceServices, nil))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)

	// metadata without a metric is a caller bug caught before any backend
	// call — no request may have been recorded.
	res, err = CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreMetricMetadata, nil))
	require.ErrorIs(t, err, connector.ErrUnsupported)
	require.Equal(t, connector.StateNotAvailable, res.State)
	require.Equal(t, "a metric name is required", res.Reason)
}

func TestExploreBackendErrorsBecomeStates(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":"detail never surfaces"}`)
	})
	creds := fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj")

	res, err := CloudMonitoring{}.Explore(context.Background(), exploreRequest(
		testConfig(t, fake.server.URL), creds, connector.ExploreMetricNames, nil))
	require.NoError(t, err)
	require.Equal(t, connector.StateForbidden, res.State)
	require.NotContains(t, res.Reason, "detail never surfaces")
	require.Nil(t, res.Data)
}
