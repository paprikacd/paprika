package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// widgetAt is a widget that reads the fake provider, placed at a grid rectangle.
// extra joins extra members, such as options.
func widgetAt(id, widgetType, query, unit string, x, y, w, h int, extra string) string {
	fragment := ""
	if extra != "" {
		fragment = "," + extra
	}
	return fmt.Sprintf(`{"id":%q,"title":%q,"type":%q,"providerId":"prometheus","query":%q,"unit":%q,"layout":{"x":%d,"y":%d,"w":%d,"h":%d}%s}`, id, "Widget "+id, widgetType, query, unit, x, y, w, h, fragment)
}

// dataWidgetJSON is a full-width widget in row y, four grid rows tall.
func dataWidgetJSON(id, widgetType, query, unit string, y int, extra string) string {
	return widgetAt(id, widgetType, query, unit, 0, y, 12, 4, extra)
}

// dataProvider is a fake Prometheus. respond picks the body for each query, given
// the query range end, so a test can place samples relative to the window. It
// counts requests and records the most that were in flight at once.
type dataProvider struct {
	calls    atomic.Int32
	inFlight atomic.Int32
	peak     atomic.Int32
	mu       sync.Mutex
	queries  []string
}

func (p *dataProvider) seen() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.queries...)
}

func newDataProvider(t *testing.T, respond func(query string, end float64) (status int, body string)) (*httptest.Server, *dataProvider) {
	t.Helper()
	p := &dataProvider{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.calls.Add(1)
		current := p.inFlight.Add(1)
		defer p.inFlight.Add(-1)
		for {
			peak := p.peak.Load()
			if current <= peak || p.peak.CompareAndSwap(peak, current) {
				break
			}
		}
		query := r.URL.Query().Get("query")
		p.mu.Lock()
		p.queries = append(p.queries, query)
		p.mu.Unlock()
		end, _ := strconv.ParseFloat(r.URL.Query().Get("end"), 64)
		status, body := respond(query, end)
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server, p
}

// promMatrix is a successful matrix answer with one series per entry, each a
// list of [timestamp, value] pairs written as JSON.
func promMatrix(series ...string) string {
	return `{"status":"success","data":{"resultType":"matrix","result":[` + strings.Join(series, ",") + `]}}`
}

// promSeries is one series whose samples are the given JSON pairs.
func promSeries(name string, pairs ...string) string {
	return fmt.Sprintf(`{"metric":{"__name__":%q},"values":[%s]}`, name, strings.Join(pairs, ","))
}

func pair(timestamp float64, value string) string {
	return fmt.Sprintf(`[%s,%q]`, strconv.FormatFloat(timestamp, 'f', 3, 64), value)
}

// dataReport is the dry-run response with execute: the CheckReport list plus the
// per-widget states.
type dataReport struct {
	Issues []struct {
		RuleID   string `json:"ruleId"`
		Severity string `json:"severity"`
		Source   string `json:"source"`
		WidgetID string `json:"widgetId"`
		Pointer  string `json:"pointer"`
		Message  string `json:"message"`
		Fix      string `json:"fix"`
	} `json:"issues"`
	Total        uint32 `json:"total"`
	ErrorCount   uint32 `json:"errorCount"`
	WarningCount uint32 `json:"warningCount"`
	Widgets      []struct {
		WidgetID       string `json:"widgetId"`
		Pointer        string `json:"pointer"`
		State          string `json:"state"`
		SeriesReturned uint32 `json:"seriesReturned"`
		ErrorCode      string `json:"errorCode"`
	} `json:"widgets"`
}

// executeDryRunRequest posts a dry run with execute and returns the decoded report.
func executeDryRunRequest(t *testing.T, s *Server, document string, variables map[string]string) (*dataReport, string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"document": json.RawMessage(document), "execute": true, "variables": variables})
	require.NoError(t, err)
	w := request(t, s.Handler(), "POST", "/api/dashboards/validate", body, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var report dataReport
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &report), w.Body.String())
	return &report, w.Body.String()
}

// dataFindingsOf returns the data.* issues of a report, in report order.
func dataFindingsOf(report *dataReport) []string {
	var rules []string
	for _, issue := range report.Issues {
		if strings.HasPrefix(issue.RuleID, "data.") {
			rules = append(rules, issue.RuleID+" "+issue.Pointer)
		}
	}
	return rules
}

func stateOf(report *dataReport, pointer string) string {
	for _, state := range report.Widgets {
		if state.Pointer == pointer {
			return state.State
		}
	}
	return ""
}

func documentOf(id string, widgets ...string) string {
	return string(documentWithWidgets(id, widgets...))
}

func TestDryRunQueryErrorIsSafeAndNamesTheMember(t *testing.T) {
	// The "boom" answer is a 200 whose body the client reads and cannot decode. Its
	// text is the leak to catch: a sanitised finding never carries it.
	provider, _ := newDataProvider(t, func(query string, _ float64) (int, string) {
		if query == "boom" {
			return http.StatusOK, "upstream secret token leaked"
		}
		return http.StatusTooManyRequests, `{"status":"error"}`
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo", dataWidgetJSON("broken", "timeseries", "boom", "req/s", 0, ""), dataWidgetJSON("busy", "timeseries", "busy", "req/s", 4, ""))
	report, raw := executeDryRunRequest(t, s, document, nil)

	require.Equal(t, []string{"data.query-error /widgets/0/query"}, dataFindingsOf(report), "a 500 is a dashboard-visible failure; a 429 is transient and silent")
	issue := report.Issues[0]
	require.Equal(t, "SEVERITY_WARNING", issue.Severity)
	require.Equal(t, "SOURCE_DATA", issue.Source)
	require.Equal(t, "broken", issue.WidgetID)
	require.Contains(t, issue.Message, "(provider_error)")
	require.NotContains(t, raw, "upstream secret token leaked", "upstream bodies never reach the report")
	require.Equal(t, uint32(0), report.ErrorCount, "data findings never block a save")
	require.Equal(t, "DATA_STATE_ERROR", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_UNAVAILABLE", stateOf(report, "/widgets/1"))
}

func TestDryRunMissingSavedQueryIsAQueryErrorOnTheReference(t *testing.T) {
	provider, _ := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	// The schema wants a query text even when a saved query supplies the query.
	widget := dataWidgetJSON("saved", "timeseries", "up", "req/s", 0, `"queryRef":{"id":"absent","bindings":[]}`)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", widget), nil)
	require.Equal(t, []string{"data.query-error /widgets/0/queryRef"}, dataFindingsOf(report))
	require.Equal(t, "DATA_STATE_ERROR", stateOf(report, "/widgets/0"))
	require.Equal(t, "missing_saved_query", report.Widgets[0].ErrorCode)
}

func TestDryRunNoSeriesOnlyForEmptyMetrics(t *testing.T) {
	provider, _ := newDataProvider(t, func(query string, end float64) (int, string) {
		if query == "absent" {
			return http.StatusOK, promMatrix()
		}
		return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo", dataWidgetJSON("missing", "timeseries", "absent", "req/s", 0, ""), dataWidgetJSON("present", "timeseries", "present", "req/s", 4, ""))
	report, _ := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, []string{"data.no-series /widgets/0/query"}, dataFindingsOf(report))
	require.Equal(t, "DATA_STATE_EMPTY", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/1"))
	require.Equal(t, uint32(1), report.Widgets[1].SeriesReturned)
}

// unitCase is one widget whose returned values are judged against its declared
// scale. The provider returns the values as one series, one sample each.
type unitCase struct {
	name, unit, options string
	values              []string
	wantRule            string // empty when no finding is expected
	wantPointer         string
	wantSeverity        string
}

func TestDryRunUnitMismatchJudgesOnlyTheDeclaredScale(t *testing.T) {
	cases := []unitCase{
		{name: "declared max exceeded", unit: "%", options: `"options":{"max":100}`, values: []string{"120"}, wantRule: "data.unit-mismatch", wantPointer: "/widgets/0/options/max", wantSeverity: "SEVERITY_INFO"},
		{name: "declared min undershot", unit: "%", options: `"options":{"min":0}`, values: []string{"-5"}, wantRule: "data.unit-mismatch", wantPointer: "/widgets/0/options/min", wantSeverity: "SEVERITY_INFO"},
		{name: "within declared range", unit: "%", options: `"options":{"min":0,"max":100}`, values: []string{"42"}},
		{name: "350 percent CPU with no declared scale", unit: "%", values: []string{"350"}},
		{name: "negative percentage change with no declared scale", unit: "%", values: []string{"-30"}},
		{name: "ratio shown as percent under a threshold of 99", unit: "%", options: `"options":{"thresholds":[{"value":99,"status":"critical"}]}`, values: []string{"0.97"}, wantRule: "data.unit-mismatch", wantPointer: "/widgets/0/unit", wantSeverity: "SEVERITY_INFO"},
		{name: "ratio shown as percent under a declared max of 100", unit: "%", options: `"options":{"max":100}`, values: []string{"0.5", "0.02"}, wantRule: "data.unit-mismatch", wantPointer: "/widgets/0/unit", wantSeverity: "SEVERITY_INFO"},
		{name: "ratio whose scale is below ten", unit: "%", options: `"options":{"thresholds":[{"value":0.9,"status":"warning"}]}`, values: []string{"0.5"}},
		{name: "all zeros is not evidence of a ratio", unit: "%", options: `"options":{"max":100}`, values: []string{"0", "0"}},
		{name: "values above one are not a ratio", unit: "%", options: `"options":{"max":100}`, values: []string{"1.5"}},
		{name: "other units are not judged against percent", unit: "req/s", options: `"options":{"max":100}`, values: []string{"0.5"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider, _ := newDataProvider(t, func(_ string, end float64) (int, string) {
				samples := make([]string, 0, len(tc.values))
				for i, value := range tc.values {
					samples = append(samples, pair(end-float64(60*(len(tc.values)-i)), value))
				}
				return http.StatusOK, promMatrix(promSeries("share", samples...))
			})
			s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			widget := widgetAt("share", "timeseries", "share", tc.unit, 0, 0, 12, 4, tc.options)
			report, _ := executeDryRunRequest(t, s, documentOf("demo", widget), nil)
			if tc.wantRule == "" {
				require.Empty(t, dataFindingsOf(report))
				return
			}
			require.Equal(t, []string{tc.wantRule + " " + tc.wantPointer}, dataFindingsOf(report))
			require.Equal(t, tc.wantSeverity, report.Issues[0].Severity)
			require.Equal(t, uint32(0), report.WarningCount, "a unit finding is info, never a warning")
			require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/0"), "a unit finding does not change the data state")
		})
	}
}

func TestDryRunStaleAfterSecondsComparesTheNewestSample(t *testing.T) {
	provider, _ := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-600, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	stale := dataWidgetJSON("stale", "stat", "stale", "req/s", 0, `"options":{"staleAfterSeconds":60}`)
	fresh := dataWidgetJSON("fresh", "stat", "fresh", "req/s", 4, `"options":{"staleAfterSeconds":3600}`)
	unset := dataWidgetJSON("unset", "stat", "unset", "req/s", 8, "")
	report, _ := executeDryRunRequest(t, s, documentOf("demo", stale, fresh, unset), nil)
	require.Equal(t, []string{"data.stale /widgets/0/options/staleAfterSeconds"}, dataFindingsOf(report))
	require.Contains(t, report.Issues[0].Message, "600 s old, past its staleAfterSeconds of 60")
	require.Equal(t, "DATA_STATE_STALE", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/1"))
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/2"), "no threshold, no staleness claim")
}

func TestDryRunSeriesCapReportsProviderTruncation(t *testing.T) {
	provider, _ := newDataProvider(t, func(query string, end float64) (int, string) {
		switch query {
		case "capped":
			return http.StatusOK, `{"status":"success","truncated":true,"data":{"resultType":"matrix","result":[` + promSeries("up", pair(end-60, "1")) + `]}}`
		default:
			return http.StatusOK, `{"status":"success","truncated":true,"data":{"resultType":"matrix","result":[]}}`
		}
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo", dataWidgetJSON("capped", "timeseries", "capped", "req/s", 0, ""), dataWidgetJSON("partial", "timeseries", "partial", "req/s", 4, ""))
	report, _ := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, []string{"data.series-cap /widgets/0/query", "data.series-cap /widgets/1/query"}, dataFindingsOf(report))
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_PARTIAL", stateOf(report, "/widgets/1"), "an empty truncated response is partial, not proven empty")
}

func TestDryRunDeduplicatesQueriesAndReportsEachWidget(t *testing.T) {
	provider, p := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo", dataWidgetJSON("a", "timeseries", "shared", "req/s", 0, ""), dataWidgetJSON("b", "timeseries", "shared", "req/s", 4, ""))
	report, _ := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, int32(1), p.calls.Load(), "identical queries run once")
	require.Equal(t, []string{"data.no-series /widgets/0/query", "data.no-series /widgets/1/query"}, dataFindingsOf(report), "each widget that shows the empty result is named")
	require.Equal(t, "DATA_STATE_EMPTY", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_EMPTY", stateOf(report, "/widgets/1"))
}

func TestDryRunRunsQueriesOneAtATimeWithinTheBound(t *testing.T) {
	provider, p := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]string, 0, maxDashboardWidgets)
	for i := range maxDashboardWidgets {
		widgets = append(widgets, dataWidgetJSON(fmt.Sprintf("w%02d", i), "timeseries", fmt.Sprintf("q%02d", i), "req/s", i*4, ""))
	}
	report, _ := executeDryRunRequest(t, s, documentOf("demo", widgets...), nil)
	require.Equal(t, int32(maxDashboardWidgets), p.calls.Load())
	require.Equal(t, int32(1), p.peak.Load(), "query_dashboard runs one provider query at a time; so does the dry run")
	require.Len(t, report.Widgets, maxDashboardWidgets)
	require.Empty(t, dataFindingsOf(report))
}

func TestDryRunCancellationStopsTheFanOut(t *testing.T) {
	// The provider holds every request until the caller gives up or the test ends.
	released := make(chan struct{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
		case <-released:
		}
	}))
	t.Cleanup(func() { close(released); provider.Close() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	document := documentOf("demo", dataWidgetJSON("a", "timeseries", "one", "req/s", 0, ""), dataWidgetJSON("b", "timeseries", "two", "req/s", 4, ""))
	body, err := json.Marshal(map[string]any{"document": json.RawMessage(document), "execute": true})
	require.NoError(t, err)
	r := httptest.NewRequestWithContext(ctx, "POST", "/api/dashboards/validate", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	started := time.Now()
	s.Handler().ServeHTTP(w, r)

	require.Less(t, time.Since(started), 10*time.Second, "the dry run ends with its caller's deadline, not the provider's")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, int32(1), calls.Load(), "the second query never starts once the deadline has passed")
	var report dataReport
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &report))
	require.Empty(t, dataFindingsOf(&report), "a timed-out or canceled query is not a dashboard fault")
	require.Equal(t, "DATA_STATE_UNAVAILABLE", stateOf(&report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_UNAVAILABLE", stateOf(&report, "/widgets/1"))
}

func TestDryRunNeverExecutesADocumentThatCannotBeSaved(t *testing.T) {
	provider, p := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	overlap := documentOf("demo",
		widgetAt("a", "timeseries", "q1", "req/s", 0, 0, 6, 4, ""),
		widgetAt("b", "timeseries", "q2", "req/s", 4, 0, 6, 4, ""),
	)
	report, _ := executeDryRunRequest(t, s, overlap, nil)
	require.Equal(t, uint32(1), report.ErrorCount)
	require.Equal(t, int32(0), p.calls.Load(), "a document with a lint error is not executed")
	require.Len(t, report.Widgets, 2)
	require.Equal(t, "DATA_STATE_NOT_RUN", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_NOT_RUN", stateOf(report, "/widgets/1"))

	schemaBroken := strings.Replace(documentOf("demo", dataWidgetJSON("a", "timeseries", "q1", "req/s", 0, "")), `"timeRange":"1h"`, `"timeRange":"2y"`, 1)
	report, _ = executeDryRunRequest(t, s, schemaBroken, nil)
	require.Positive(t, report.ErrorCount)
	require.Equal(t, int32(0), p.calls.Load(), "a schema failure is not executed")
	require.Equal(t, "DATA_STATE_NOT_RUN", stateOf(report, "/widgets/0"))
}

func TestDryRunLintWarningsDoNotStopExecution(t *testing.T) {
	provider, p := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	compact := widgetAt("compact", "stat", "up", "req/s", 0, 0, 12, 2, `"options":{"showStatBar":true,"showSparkline":true,"min":0,"max":100}`)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", compact), nil)
	require.Equal(t, int32(1), p.calls.Load(), "warnings are advisory, so the query runs")
	require.Equal(t, uint32(1), report.WarningCount)
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/0"))
}

func TestDryRunPassesVariablesAndNeverWrites(t *testing.T) {
	provider, p := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
	})
	s, store := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := `{"schemaVersion":1,"id":"demo","title":"Vars","timeRange":"1h","refreshInterval":30,"variables":[{"name":"service","label":"Service","defaultValue":"checkout"}],"widgets":[` +
		dataWidgetJSON("requests", "timeseries", `up{service={{service}}}`, "req/s", 0, "") + `]}`
	report, _ := executeDryRunRequest(t, s, document, map[string]string{"service": "api"})
	require.Equal(t, []string{`up{service="api"}`}, p.seen())
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/0"))
	_, _, err := store.Get("demo")
	require.ErrorIs(t, err, ErrNotFound, "a dry run never saves")
}

func TestDryRunVariablesAreAnInputErrorWithoutExecute(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := documentOf("demo", dataWidgetJSON("a", "timeseries", "q", "req/s", 0, ""))
	withoutExecute := []byte(`{"document":` + document + `,"variables":{"service":"api"}}`)
	require.Equal(t, http.StatusBadRequest, request(t, h, "POST", "/api/dashboards/validate", withoutExecute, nil).Code)

	undeclared := []byte(`{"document":` + document + `,"execute":true,"variables":{"service":"api"}}`)
	w := request(t, h, "POST", "/api/dashboards/validate", undeclared, nil)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Contains(t, w.Body.String(), "declared dashboard variables")

	many := make(map[string]string, checkwire.MaxDryRunVariables+1)
	for i := range checkwire.MaxDryRunVariables + 1 {
		many[fmt.Sprintf("v%02d", i)] = "x"
	}
	body, err := json.Marshal(map[string]any{"document": json.RawMessage(document), "execute": true, "variables": many})
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, request(t, h, "POST", "/api/dashboards/validate", body, nil).Code)
}

func TestDryRunWithoutExecuteKeepsTheCheckReportShape(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "POST", "/api/dashboards/validate", checkBody(documentWithWidgets("demo", widgetJSON("requests", "", ""))), nil)
	require.Equal(t, http.StatusOK, w.Code)
	var shape map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &shape))
	require.NotContains(t, shape, "widgets", "a dry run that did not execute adds no member")
}

func TestDataRegistryIsDocumentedAndSharesOneCatalogue(t *testing.T) {
	seen := map[string]bool{}
	for _, rule := range dataRules {
		require.True(t, strings.HasPrefix(rule.ID, "data."), rule.ID)
		require.False(t, seen[rule.ID], "duplicate rule %s", rule.ID)
		seen[rule.ID] = true
		require.Contains(t, []insightsv1.Severity{insightsv1.Severity_SEVERITY_WARNING, insightsv1.Severity_SEVERITY_INFO}, rule.Severity, rule.ID)
		require.NotEmpty(t, rule.Summary, rule.ID)
		require.NotEmpty(t, rule.Fix, rule.ID)
	}
	require.Len(t, dataRules, 7)

	catalogue := checkRuleCatalog()
	require.Len(t, catalogue, len(lintRules)+len(dataRules))
	ids := map[string]bool{}
	for _, entry := range catalogue {
		require.False(t, ids[entry.ID], "one catalogue, one id per rule: %s", entry.ID)
		ids[entry.ID] = true
		require.NotEmpty(t, entry.Summary, entry.ID)
		wantSource := insightsv1.Source_SOURCE_LINT
		if strings.HasPrefix(entry.ID, "data.") {
			wantSource = insightsv1.Source_SOURCE_DATA
		}
		require.Equal(t, wantSource, entry.Source, "lint and data keep their own source: %s", entry.ID)
	}
}

// A direct Prometheus 502 or 503 is a gateway or an aborted or timed-out query,
// which a retry can clear, so the dry run reports it unavailable, not as a
// dashboard fault. A 500 stays a finding. query_dashboard keeps its own codes:
// its output is unchanged, so a 503 is still provider_error there.
func TestDryRunGatewayAndUnavailableStatusesAreTransient(t *testing.T) {
	provider, _ := newDataProvider(t, func(query string, _ float64) (int, string) {
		switch query {
		case "gateway":
			return http.StatusBadGateway, `{"status":"error"}`
		case "unavailable":
			return http.StatusServiceUnavailable, `{"status":"error","errorType":"timeout"}`
		default:
			return http.StatusInternalServerError, `{"status":"error"}`
		}
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo",
		dataWidgetJSON("gateway", "timeseries", "gateway", "req/s", 0, ""),
		dataWidgetJSON("unavailable", "timeseries", "unavailable", "req/s", 4, ""),
		dataWidgetJSON("broken", "timeseries", "broken", "req/s", 8, ""),
	)
	report, _ := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, []string{"data.query-error /widgets/2/query"}, dataFindingsOf(report))
	require.Equal(t, "DATA_STATE_UNAVAILABLE", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_UNAVAILABLE", stateOf(report, "/widgets/1"))
	require.Equal(t, "DATA_STATE_ERROR", stateOf(report, "/widgets/2"))

	putReadDashboard(t, s, queryReadWidget("busy", "unavailable"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, "provider_error", result.Signals[0].Error.Code, "query_dashboard keeps the code it reported before")
}

func TestDryRunStaleCoversStatAndTimeseriesOnly(t *testing.T) {
	provider, _ := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-600, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	stale := `"options":{"staleAfterSeconds":60}`
	series := widgetAt("series", "timeseries", "series", "req/s", 0, 0, 12, 4, stale)
	rich := widgetAt("rich", "plugin", "rich", "req/s", 0, 4, 12, 4, `"pluginId":"rich-metrics","dataKind":"metrics",`+stale)
	bar := widgetAt("bar", "bar", "bar", "req/s", 0, 8, 12, 4, stale)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", series, rich, bar), nil)
	require.Equal(t, []string{"data.stale /widgets/0/options/staleAfterSeconds"}, dataFindingsOf(report),
		"only timeseries is judged here; the UI marks stale on stat and timeseries alone, and rich metrics use staleAfterSeconds only as a track-end grace")
	require.Equal(t, "DATA_STATE_STALE", stateOf(report, "/widgets/0"))
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/1"), "rich metrics make no stale claim")
	require.Equal(t, "DATA_STATE_OK", stateOf(report, "/widgets/2"), "bar charts do not honour staleAfterSeconds")
}

// An alert or a comparison filter is often empty by design, so its empty result is
// info; a plain metric that is empty stays a warning.
func TestDryRunNoSeriesIsInfoForAlertsAndComparisonFilters(t *testing.T) {
	provider, _ := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := documentOf("demo",
		dataWidgetJSON("alerts", "timeseries", `ALERTS{alertstate="firing"}`, "req/s", 0, ""),
		dataWidgetJSON("filter", "timeseries", "error_rate > 0", "req/s", 4, ""),
		dataWidgetJSON("plain", "timeseries", "requests_total", "req/s", 8, ""),
	)
	report, _ := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, []string{"data.no-series /widgets/0/query", "data.no-series /widgets/1/query", "data.no-series /widgets/2/query"}, dataFindingsOf(report))
	require.Equal(t, "SEVERITY_INFO", report.Issues[0].Severity)
	require.Equal(t, "SEVERITY_INFO", report.Issues[1].Severity)
	require.Equal(t, "SEVERITY_WARNING", report.Issues[2].Severity)
	require.Contains(t, report.Issues[0].Message, "can legitimately be empty")
	require.Equal(t, uint32(1), report.WarningCount)
}

// A provider-setting failure points at the provider, not the query.
func TestDryRunProviderSettingFailuresPointAtProviderID(t *testing.T) {
	s, _ := testService(t)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", dataWidgetJSON("orphan", "timeseries", "up", "req/s", 0, "")), nil)
	require.Equal(t, []string{"data.query-error /widgets/0/providerId"}, dataFindingsOf(report))
	require.Contains(t, report.Issues[0].Message, "(provider_not_found)")
}

// A failed event query keeps its finding and makes the widget partial, so the
// widget is not reported as complete.
func TestDryRunFailedEventQueryMakesTheWidgetPartial(t *testing.T) {
	provider, _ := newDataProvider(t, func(_ string, end float64) (int, string) {
		return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	annotated := dataWidgetJSON("annotated", "timeseries", "up", "req/s", 0,
		`"annotationSource":{"queryRef":{"id":"absent","bindings":[]},"timestampColumn":"at","labelColumn":"label"}`)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", annotated), nil)
	require.Equal(t, []string{"data.query-error /widgets/0/annotationSource"}, dataFindingsOf(report))
	require.Equal(t, "DATA_STATE_PARTIAL", stateOf(report, "/widgets/0"))
}

func TestDryRunManySeriesAdvisoryNeedsSeriesColors(t *testing.T) {
	series := make([]string, 0, 9)
	for i := range 9 {
		series = append(series, promSeries(fmt.Sprintf("s%d", i), pair(1, "1")))
	}
	provider, _ := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix(series...) })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	plain := dataWidgetJSON("plain", "timeseries", "many", "req/s", 0, "")
	coloured := dataWidgetJSON("coloured", "timeseries", "many", "req/s", 4, `"options":{"seriesColors":[{"label":"s0","value":"s0","color":"#111111"}]}`)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", plain, coloured), nil)
	require.Equal(t, []string{"data.many-series /widgets/0/query"}, dataFindingsOf(report))
	require.Equal(t, "SEVERITY_INFO", report.Issues[0].Severity)
	require.Equal(t, uint32(9), report.Widgets[0].SeriesReturned)
}

func TestDryRunConstantSparklineAdvisory(t *testing.T) {
	provider, _ := newDataProvider(t, func(query string, end float64) (int, string) {
		if query == "flat" {
			return http.StatusOK, promMatrix(promSeries("target", pair(end-120, "99"), pair(end-60, "99")))
		}
		return http.StatusOK, promMatrix(promSeries("rate", pair(end-120, "98"), pair(end-60, "99")))
	})
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	flat := widgetAt("target", "stat", "flat", "%", 0, 0, 4, 4, `"options":{"showSparkline":true,"decimals":0}`)
	moving := widgetAt("rate", "stat", "rate", "%", 4, 0, 4, 4, `"options":{"showSparkline":true,"decimals":0}`)
	report, _ := executeDryRunRequest(t, s, documentOf("demo", flat, moving), nil)
	require.Equal(t, []string{"data.constant-sparkline /widgets/0/options/showSparkline"}, dataFindingsOf(report))
	require.Equal(t, "SEVERITY_INFO", report.Issues[0].Severity)
	require.Contains(t, report.Issues[0].Message, "all 2 valid samples equal 99")
}

// A widget whose id is not a string blanks only its own id; every widget is still
// reported as not run, so the report never claims there were no widgets.
func TestNotRunStatesKeepEveryWidgetWhenAnIDIsNotAString(t *testing.T) {
	document := strings.Replace(string(documentOf("demo", dataWidgetJSON("first", "timeseries", "up", "req/s", 0, ""), dataWidgetJSON("second", "timeseries", "up", "req/s", 4, ""))), `"id":"first"`, `"id":5`, 1)
	states := notRunStates(Dashboard(document))
	require.Len(t, states, 2)
	require.Empty(t, states[0].GetWidgetId())
	require.Equal(t, "second", states[1].GetWidgetId())
	for _, state := range states {
		require.Equal(t, insightsv1.DataState_DATA_STATE_NOT_RUN, state.GetState())
	}
}

// The largest dry run the service takes: a document near its size limit and 20
// variable values of 1024 units, every unit escaped to six bytes. The envelope
// is larger than the old 32 KiB allowance, so the test fails if that is restored.
func TestDryRunAcceptsWorstCaseVariableEnvelope(t *testing.T) {
	provider, _ := newDataProvider(t, func(string, float64) (int, string) { return http.StatusOK, promMatrix() })
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	declared := make([]map[string]string, 0, checkwire.MaxDryRunVariables)
	values := make(map[string]string, checkwire.MaxDryRunVariables)
	for i := range checkwire.MaxDryRunVariables {
		name := fmt.Sprintf("v%02d", i)
		declared = append(declared, map[string]string{"name": name})
		values[name] = strings.Repeat("<", checkwire.MaxDryRunVariableUnits)
	}
	widgets := make([]string, 0, maxDashboardWidgets)
	for i := range maxDashboardWidgets {
		query := fmt.Sprintf("q%02d%s", i, strings.Repeat("x", 4700))
		widgets = append(widgets, dataWidgetJSON(fmt.Sprintf("w%02d", i), "timeseries", query, "req/s", i*4, ""))
	}
	variables, err := json.Marshal(declared)
	require.NoError(t, err)
	document := `{"schemaVersion":1,"id":"demo","title":"Worst case","timeRange":"1h","refreshInterval":30,"variables":` + string(variables) + `,"widgets":[` + strings.Join(widgets, ",") + `]}`
	encoded, err := json.Marshal(values)
	require.NoError(t, err)
	body := []byte(`{"document":` + document + `,"execute":true,"variables":` + string(encoded) + `}`)
	require.Greater(t, len(body), maxDocumentBytes+32<<10, "the request is larger than the old allowance")
	require.LessOrEqual(t, len(body), maxDocumentBytes+checkwire.DryRunEnvelopeBytes, "and within the new one")
	w := request(t, s.Handler(), "POST", "/api/dashboards/validate", body, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}
