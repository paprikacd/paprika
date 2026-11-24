package insights

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
)

func labelValuesSource(label string, selector *string) *dashboardReadVariableSource {
	return &dashboardReadVariableSource{Type: "labelValues", ProviderID: "prometheus", Label: label, Selector: selector}
}

func TestVariableBucket(t *testing.T) {
	for _, tc := range []struct {
		start, end  float64
		wantStart   int64
		wantEnd     int64
		description string
	}{
		{1700000030, 1700000500, 1699999980, 1700000460, "both ends round down to the minute"},
		{60, 119.9, 60, 120, "a sub-minute range still spans one bucket"},
		{59.9, 300, 0, 300, "an earlier start rounds down to the same minute"},
	} {
		gotStart, gotEnd := variableBucket(tc.start, tc.end)
		require.Equal(t, tc.wantStart, gotStart, tc.description)
		require.Equal(t, tc.wantEnd, gotEnd, tc.description)
	}
}

func TestNormalizeVariableValues(t *testing.T) {
	values, truncated := normalizeVariableValues([]string{"a", "b", "a", "c"}, 2)
	require.Equal(t, []string{"a", "b"}, values)
	require.True(t, truncated, "a cut list is truncated")

	values, truncated = normalizeVariableValues([]string{"a", "b"}, 5)
	require.Equal(t, []string{"a", "b"}, values)
	require.False(t, truncated)

	tooLong := strings.Repeat("x", variableValueMaxUnits+1)
	values, truncated = normalizeVariableValues([]string{tooLong, "ok"}, 5)
	require.Equal(t, []string{"ok"}, values, "a value over 1024 units is dropped")
	require.True(t, truncated)

	exact := strings.Repeat("x", variableValueMaxUnits)
	values, truncated = normalizeVariableValues([]string{exact}, 5)
	require.Equal(t, []string{exact}, values, "a value of exactly 1024 units is kept")
	require.False(t, truncated)
}

func TestVariableValuesFromResult(t *testing.T) {
	values, truncated, failure := variableValuesFromResult(&QueryResult{Records: &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "service"}},
		Rows:    [][]any{{"api"}, {1.5}, {nil}, {""}, {"api"}, {true}},
	}}, "service")
	require.Nil(t, failure)
	require.Equal(t, []string{"api", "1.5"}, values, "string and finite number cells, distinct and non-empty")
	require.False(t, truncated)

	_, truncated, failure = variableValuesFromResult(&QueryResult{Records: &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "service"}}, Rows: [][]any{{"api"}}, Truncated: true,
	}}, "service")
	require.Nil(t, failure)
	require.True(t, truncated, "a truncated records frame truncates the values")

	_, _, failure = variableValuesFromResult(&QueryResult{Records: &dataframe.Frame{Columns: []dataframe.Column{{Key: "other"}}}}, "service")
	require.NotNil(t, failure)
	require.Equal(t, "invalid_source_field", failure.Code)

	values, _, failure = variableValuesFromResult(&QueryResult{Series: []Series{
		{Labels: map[string]string{"zone": "a"}}, {Labels: map[string]string{"zone": ""}}, {Labels: map[string]string{"zone": "b"}},
	}}, "zone")
	require.Nil(t, failure)
	require.Equal(t, []string{"a", "b"}, values)

	_, _, failure = variableValuesFromResult(&QueryResult{Series: []Series{{Labels: map[string]string{"other": "x"}}}}, "zone")
	require.NotNil(t, failure)
	require.Equal(t, "invalid_source_field", failure.Code)

	_, _, failure = variableValuesFromResult(&QueryResult{Traces: []Trace{{TraceID: "t"}}}, "service")
	require.NotNil(t, failure)
	require.Equal(t, "incompatible_saved_query", failure.Code)
}

func TestVariableSourceDependencies(t *testing.T) {
	selector := "up{zone={{zone}},pod={{pod}},zone={{zone}}}"
	source := &dashboardReadVariableSource{
		Type: "labelValues", Selector: &selector,
		QueryRef: &dashboardReadReference{ID: "q", Bindings: []dashboardReadBinding{{Source: "variable", Variable: "region"}, {Source: "constant"}}},
	}
	require.Equal(t, []string{"zone", "pod", "region"}, variableSourceDependencies(source))
}

// variableSourceServer answers the label and query requests a variable source makes, and records each one.
type variableSourceServer struct {
	mu       sync.Mutex
	requests []url.Values
	paths    []string
}

func (v *variableSourceServer) handler(delay time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v.mu.Lock()
		v.paths = append(v.paths, r.URL.Path)
		v.requests = append(v.requests, r.URL.Query())
		v.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		switch r.URL.Path {
		case "/api/v1/label/zone/values":
			_, _ = fmt.Fprint(w, `{"status":"success","data":["a","b","a"]}`)
		case "/api/v1/label/pod/values":
			_, _ = fmt.Fprint(w, `{"status":"success","data":["p1"]}`)
		case "/api/v1/query_range":
			_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1700000000,"1"]]},{"metric":{"service":"db"},"values":[[1700000000,"2"]]}]}}`)
		default:
			_, _ = fmt.Fprint(w, `{"status":"success","data":[]}`)
		}
	})
}

func (v *variableSourceServer) count(path string) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	total := 0
	for _, seen := range v.paths {
		if seen == path {
			total++
		}
	}
	return total
}

func TestResolveVariableSources(t *testing.T) {
	fake := &variableSourceServer{}
	provider := httptest.NewServer(fake.handler(0))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil)
	podSelector := "up{zone={{zone}}}"
	orphanSelector := "up{x={{missing}}}"
	definitions := []dashboardReadVariable{
		{Name: "zone", Source: labelValuesSource("zone", nil)},
		{Name: "pod", Source: labelValuesSource("pod", &podSelector)},
		{Name: "dup", Source: labelValuesSource("zone", nil)},
		{Name: "orphan", Source: labelValuesSource("pod", &orphanSelector)},
		{Name: "service", Source: &dashboardReadVariableSource{Type: "savedQuery", Field: "service", QueryRef: &dashboardReadReference{ID: "hosts"}}},
		{Name: "plain"},
	}
	saved := map[string]dashboardSavedSnapshot{"hosts": {Query: SavedQuery{ID: "hosts", ProviderID: "prometheus", Kind: "metrics", Query: "up"}}}
	values := map[string]string{"zone": "a"}
	cache := &dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}
	start, end := 1700000030.0, 1700000500.0

	outcomes, count := s.resolveVariableSources(r, time.Minute, definitions, values, saved, start, end, cache, nil)

	require.Equal(t, "ready", outcomes[0].state)
	require.Equal(t, []string{"a", "b"}, outcomes[0].values)
	require.Equal(t, "ready", outcomes[1].state, "a selector reads the current parent value")
	require.Equal(t, []string{"p1"}, outcomes[1].values)
	require.Equal(t, "ready", outcomes[2].state, "an identical source reuses the fetch")
	require.Equal(t, []string{"a", "b"}, outcomes[2].values)
	require.Equal(t, "needs_variable", outcomes[3].state)
	require.Equal(t, "missing", outcomes[3].needsVariable)
	require.Equal(t, "ready", outcomes[4].state, "a saved-query source reads the field's series labels")
	require.Equal(t, []string{"api", "db"}, outcomes[4].values)
	require.False(t, outcomes[5].sourced, "a variable without a source has no outcome")
	require.Equal(t, 1, fake.count("/api/v1/label/zone/values"), "identical sources are fetched once")
	require.NotNil(t, count)
	require.Equal(t, 3, count.Planned, "zone, pod and the saved query are distinct fetches")
	require.Equal(t, 3, count.Executed)

	fake.mu.Lock()
	defer fake.mu.Unlock()
	for i, path := range fake.paths {
		if path != "/api/v1/label/pod/values" {
			continue
		}
		require.Equal(t, `up{zone="a"}`, fake.requests[i].Get("match[]"), "the selector takes the parent value")
		from, _ := strconv.ParseInt(fake.requests[i].Get("start"), 10, 64)
		to, _ := strconv.ParseInt(fake.requests[i].Get("end"), 10, 64)
		require.Equal(t, int64(0), from%variableRangeBucketSeconds, "the start is bucketed to the minute")
		require.Equal(t, int64(0), to%variableRangeBucketSeconds, "the end is bucketed to the minute")
		require.Greater(t, to, from)
	}
}

func TestResolveVariableSourcesMarksUnstartedFetchesNotRun(t *testing.T) {
	fake := &variableSourceServer{}
	provider := httptest.NewServer(fake.handler(300 * time.Millisecond))
	defer provider.Close()
	s, _ := testServiceWithDashboardParallelism(t, 1, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil)
	definitions := []dashboardReadVariable{
		{Name: "zone", Source: labelValuesSource("zone", nil)},
		{Name: "pod", Source: labelValuesSource("pod", nil)},
	}
	cache := &dashboardQueryProviders{clients: make(map[string]*providerClient), errors: make(map[string]error)}

	outcomes, count := s.resolveVariableSources(r, 50*time.Millisecond, definitions, nil, nil, 1700000030, 1700000500, cache, nil)

	require.Equal(t, "failed", outcomes[0].state, "the started fetch stops at the budget")
	require.Equal(t, "not_run", outcomes[1].state, "a fetch the budget ends before starting is not run")
	require.Equal(t, 2, count.Planned)
	require.Equal(t, 1, count.Executed)
}
