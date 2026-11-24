package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// sloConfigJSON is a valid objective config. Fields in extra replace or add members to it.
func sloConfigJSON(extra string) string {
	base := `{"objective":99.9,"period":"30d","total":"http_requests_total{service={{service}}}","bad":"http_requests_total{code=\"5xx\"}","burnAlerts":"none"`
	if extra != "" {
		base += "," + extra
	}
	return base + "}"
}

// sloWidgetJSON is a plugin widget with the given config member, or none when config is empty.
func sloWidgetJSON(id, config string) string {
	member := ""
	if config != "" {
		member = `,"config":` + config
	}
	return fmt.Sprintf(`{"id":%q,"title":"SLO","type":"plugin","pluginId":"slo-summary","dataKind":"metrics","providerId":"prometheus","query":"stale","unit":"%%","layout":{"x":0,"y":0,"w":6,"h":4}%s}`, id, member)
}

func sloDocument(widget string) Dashboard {
	return Dashboard(fmt.Sprintf(`{"schemaVersion":1,"id":"demo","title":"Demo","timeRange":"1h","refreshInterval":30,"widgets":[%s]}`, widget))
}

func TestSLOSummaryConfigIsValidatedOnSave(t *testing.T) {
	valid := []string{
		sloConfigJSON(""),
		sloConfigJSON(`"groupBy":"service","maxRows":10,"burnAlerts":"page"`),
	}
	for _, config := range valid {
		if err := validateDashboard("demo", sloDocument(sloWidgetJSON("slo", config))); err != nil {
			t.Fatalf("valid slo-summary config rejected: %v\n%s", err, config)
		}
	}
	invalid := map[string]string{
		"missing config":        "",
		"null config":           "null",
		"objective too high":    `{"objective":100,"period":"30d","total":"up","bad":"up_bad"}`,
		"objective five places": `{"objective":99.99999,"period":"30d","total":"up","bad":"up_bad"}`,
		"unknown period":        `{"objective":99.9,"period":"90d","total":"up","bad":"up_bad"}`,
		"rate call selector":    `{"objective":99.9,"period":"30d","total":"rate(up[5m])","bad":"up_bad"}`,
		"both good and bad":     `{"objective":99.9,"period":"30d","total":"up","bad":"up_bad","good":"up_good"}`,
		"neither good nor bad":  `{"objective":99.9,"period":"30d","total":"up"}`,
		"unknown key":           `{"objective":99.9,"period":"30d","total":"up","bad":"up_bad","script":"x"}`,
		"reserved group label":  `{"objective":99.9,"period":"30d","total":"up","bad":"up_bad","groupBy":"slo_window"}`,
		"too many rows":         `{"objective":99.9,"period":"30d","total":"up","bad":"up_bad","maxRows":13}`,
		"unknown burn preset":   `{"objective":99.9,"period":"30d","total":"up","bad":"up_bad","burnAlerts":"email"}`,
	}
	for name, config := range invalid {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", sloDocument(sloWidgetJSON("slo", config))); err == nil {
				t.Fatalf("invalid slo-summary config accepted: %s", config)
			}
		})
	}
}

func TestSLOSummaryStepSpansTheRange(t *testing.T) {
	widget := &dashboardReadWidget{Type: "plugin", PluginID: sloSummaryPluginID}
	if got := dashboardWidgetStep(widget, 0, 3600, 15); got != 3600 {
		t.Fatalf("slo step over 1h = %v, want 3600", got)
	}
	if got := dashboardWidgetStep(widget, 0, 10, 15); got != 60 {
		t.Fatalf("slo step over 10s = %v, want the 60s floor", got)
	}
	plain := &dashboardReadWidget{Type: "timeseries"}
	if got := dashboardWidgetStep(plain, 0, 3600, 15); got != 15 {
		t.Fatalf("ordinary step = %v, want the policy step 15 for a 15 s minimum", got)
	}
}

// providerRecorder answers every query_range with an empty matrix and records each query and step it receives.
type providerRecorder struct {
	mu    sync.Mutex
	query []string
	step  []string
}

func (p *providerRecorder) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		p.query = append(p.query, r.URL.Query().Get("query"))
		p.step = append(p.step, r.URL.Query().Get("step"))
		p.mu.Unlock()
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	})
}

func TestSLOSummaryExecutesItsCompiledQueryOverTheRange(t *testing.T) {
	recorder := &providerRecorder{}
	provider := httptest.NewServer(recorder.handler())
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	config := json.RawMessage(sloConfigJSON(""))
	cfg, err := validateSLOSummaryConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := compileSLOQuery(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	// The variable default is "checkout"; the compiled text carries the placeholder, which expands to a literal.
	want := strings.ReplaceAll(compiled, "{{service}}", `"checkout"`)

	putReadDashboard(t, s, map[string]any{"id": "slo", "title": "SLO", "type": "plugin", "pluginId": "slo-summary", "dataKind": "metrics", "providerId": "prometheus", "query": "stale text", "unit": "%", "layout": map[string]int{"x": 0, "y": 0, "w": 6, "h": 4}, "config": config})
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if len(result.Widgets) != 1 || result.Widgets[0].Error != nil {
		t.Fatalf("slo widget failed: %+v", result.Widgets)
	}
	if len(recorder.query) != 1 {
		t.Fatalf("provider received %d queries, want 1", len(recorder.query))
	}
	if recorder.query[0] != want {
		t.Fatalf("executed query is not the compiled config\n got: %s\nwant: %s", recorder.query[0], want)
	}
	if recorder.step[0] != "3600" {
		t.Fatalf("slo step = %s, want 3600 for the one hour window", recorder.step[0])
	}
}

func TestSLOSummaryNeedsAPrometheusProvider(t *testing.T) {
	recorder := &providerRecorder{}
	provider := httptest.NewServer(recorder.handler())
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "tempo", URL: provider.URL})
	putReadDashboard(t, s, map[string]any{"id": "slo", "title": "SLO", "type": "plugin", "pluginId": "slo-summary", "dataKind": "metrics", "providerId": "prometheus", "query": "stale", "unit": "%", "layout": map[string]int{"x": 0, "y": 0, "w": 6, "h": 4}, "config": json.RawMessage(sloConfigJSON(""))})
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if len(result.Widgets) != 1 || result.Widgets[0].Error == nil || result.Widgets[0].Error.Code != "invalid_query" {
		t.Fatalf("slo widget on a non-Prometheus provider = %+v, want invalid_query", result.Widgets)
	}
	if len(recorder.query) != 0 {
		t.Fatalf("provider was called %d times for a rejected widget", len(recorder.query))
	}
}

func TestSLOSummaryLintRules(t *testing.T) {
	config := sloConfigJSON("")
	cfg, err := validateSLOSummaryConfig(json.RawMessage(config))
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := compileSLOQuery(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	quoted, err := json.Marshal(compiled)
	if err != nil {
		t.Fatal(err)
	}
	slo := func(id, query, extra string) string {
		fields := `"query":` + query
		if extra != "" {
			fields += "," + extra
		}
		return fmt.Sprintf(`{"id":%q,"title":"SLO","type":"plugin","pluginId":"slo-summary","dataKind":"metrics","providerId":"prometheus",%s,"unit":"%%%%","layout":{"x":0,"y":0,"w":6,"h":4},"config":%s}`, id, fields, config)
	}
	t.Run("compiled query is quiet", func(t *testing.T) {
		findings := lintFor(t, sloDocument(slo("slo", string(quoted), "")))
		for _, finding := range findings {
			if strings.HasPrefix(finding.GetRuleId(), "slo.") {
				t.Fatalf("unexpected SLO finding: %v", finding)
			}
		}
	})
	t.Run("stale query is informational", func(t *testing.T) {
		finding := requireOneHit(t, lintFor(t, sloDocument(slo("slo", `"stale text"`, ""))), "slo.query-stale", "/widgets/0/query")
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_INFO {
			t.Fatalf("slo.query-stale severity = %v, want info", finding.GetSeverity())
		}
	})
	t.Run("saved query reference is an error", func(t *testing.T) {
		finding := requireOneHit(t, lintFor(t, sloDocument(slo("slo", string(quoted), `"queryRef":{"id":"shared"}`))), "slo.query-ref", "/widgets/0/queryRef")
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR {
			t.Fatalf("slo.query-ref severity = %v, want error", finding.GetSeverity())
		}
	})
	t.Run("thresholds are ignored with a warning", func(t *testing.T) {
		finding := requireOneHit(t, lintFor(t, sloDocument(slo("slo", string(quoted), `"options":{"thresholds":[{"value":1,"status":"critical"}]}`))), "slo.thresholds-ignored", "/widgets/0/options/thresholds")
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
			t.Fatalf("slo.thresholds-ignored severity = %v, want warning", finding.GetSeverity())
		}
	})
}

func TestSLOSummaryQueryLengthIsCheckedAfterExpansion(t *testing.T) {
	widget := &dashboardReadWidget{Type: "plugin", PluginID: sloSummaryPluginID}
	window := Query{ProviderID: "prometheus", Kind: "metrics", Start: 1000, End: 4600, Step: 3600}
	short := &Query{ProviderID: window.ProviderID, Kind: window.Kind, Start: window.Start, End: window.End, Step: window.Step, Query: strings.Repeat("a", sloMaxQueryLength)}
	if failure := validatePlannedDashboardQuery(widget, short, nil, nil); failure != nil {
		t.Fatalf("query of %d characters rejected: %+v", len(short.Query), failure)
	}
	long := &Query{ProviderID: window.ProviderID, Kind: window.Kind, Start: window.Start, End: window.End, Step: window.Step, Query: strings.Repeat("a", sloMaxQueryLength+1)}
	if failure := validatePlannedDashboardQuery(widget, long, nil, nil); failure == nil || failure.Code != "invalid_query" {
		t.Fatalf("expanded query of %d characters accepted: %+v", len(long.Query), failure)
	}
	plain := &dashboardReadWidget{Type: "timeseries"}
	if failure := validatePlannedDashboardQuery(plain, long, nil, nil); failure != nil {
		t.Fatalf("ordinary widget limited by the SLO length: %+v", failure)
	}
}

// sloProviderDocument is a valid slo-summary document whose widget names providerID.
func sloProviderDocument(t *testing.T, providerID string) Dashboard {
	t.Helper()
	config := sloConfigJSON("")
	cfg, err := validateSLOSummaryConfig(json.RawMessage(config))
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := compileSLOQuery(&cfg)
	if err != nil {
		t.Fatal(err)
	}
	quoted, err := json.Marshal(compiled)
	if err != nil {
		t.Fatal(err)
	}
	return sloDocument(fmt.Sprintf(`{"id":"slo","title":"SLO","type":"plugin","pluginId":"slo-summary","dataKind":"metrics","providerId":%q,"query":%s,"unit":"%%%%","layout":{"x":0,"y":0,"w":6,"h":4},"config":%s}`, providerID, quoted, config))
}

// findingsWithProviders runs lint with resolved provider types, as a save or a dry run does.
func findingsWithProviders(document Dashboard, providerTypes map[string]string) []*insightsv1.CheckFinding {
	set := newFindingSet(unboundedFindings)
	lintInto(set, document, storedLint{}, providerTypes)
	return set.findings()
}

func TestSLOSummaryProviderTypeLint(t *testing.T) {
	document := sloProviderDocument(t, "metrics")
	t.Run("a non-Prometheus provider is an error", func(t *testing.T) {
		finding := requireOneHit(t, findingsWithProviders(document, map[string]string{"metrics": "cloudwatch"}), "slo.provider-type", "/widgets/0/providerId")
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR {
			t.Fatalf("slo.provider-type severity = %v, want error", finding.GetSeverity())
		}
	})
	t.Run("a Prometheus provider is quiet", func(t *testing.T) {
		requireNoHits(t, findingsWithProviders(document, map[string]string{"metrics": "prometheus"}), "slo.provider-type")
	})
	t.Run("an unknown provider does not fire", func(t *testing.T) {
		requireNoHits(t, findingsWithProviders(document, nil), "slo.provider-type")
		requireNoHits(t, findingsWithProviders(document, map[string]string{"other": "cloudwatch"}), "slo.provider-type")
	})
	t.Run("the save path resolves the provider and rejects a non-Prometheus one", func(t *testing.T) {
		s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "tempo", URL: "http://127.0.0.1:1"})
		findings := s.checkReport(httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil), document).findings()
		requireOneHit(t, findings, "slo.provider-type", "/widgets/0/providerId")
	})
	t.Run("the save path leaves an unconfigured provider unreported", func(t *testing.T) {
		s, _ := testService(t, ProviderConfig{ID: "other", Name: "Other", Type: "tempo", URL: "http://127.0.0.1:1"})
		findings := s.checkReport(httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil), document).findings()
		requireNoHits(t, findings, "slo.provider-type")
	})
}

func TestSLOSummaryGroupMatcherLint(t *testing.T) {
	grouped := func(total, groupBy string) Dashboard {
		config := fmt.Sprintf(`{"objective":99.9,"period":"30d","total":%q,"bad":"http_requests_total{code=\"5xx\"}","burnAlerts":"none","groupBy":%q}`, total, groupBy)
		return sloDocument(sloWidgetJSON("slo", config))
	}
	t.Run("a matcher on the groupBy label is quiet", func(t *testing.T) {
		requireNoHits(t, lintFor(t, grouped(`http_requests_total{service=~"api|web"}`, "service")), "slo.group-unbounded")
	})
	t.Run("a template matcher on the groupBy label is quiet", func(t *testing.T) {
		requireNoHits(t, lintFor(t, grouped(`http_requests_total{service=~{{service}}}`, "service")), "slo.group-unbounded")
	})
	t.Run("a matcher on another label does not bound the groups", func(t *testing.T) {
		finding := requireOneHit(t, lintFor(t, grouped(`http_requests_total{region="eu"}`, "service")), "slo.group-unbounded", "/widgets/0/config/total")
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
			t.Fatalf("slo.group-unbounded severity = %v, want warning", finding.GetSeverity())
		}
	})
	t.Run("an ungrouped objective is not checked", func(t *testing.T) {
		requireNoHits(t, lintFor(t, grouped(`http_requests_total{region="eu"}`, "")), "slo.group-unbounded")
	})
	// A matcher that does not pin the label to a finite set leaves the groups unbounded.
	for _, total := range []string{
		`http_requests_total{service!="api"}`,
		`http_requests_total{service!~"api"}`,
		`http_requests_total{service=~".+"}`,
		`http_requests_total{service=~".*"}`,
		`http_requests_total{service!=""}`,
		`http_requests_total{service=""}`,
		`http_requests_total{path="/service=x"}`,
		`http_requests_total{region="eu", service!="api"}`,
	} {
		t.Run("does not bound the groups: "+total, func(t *testing.T) {
			requireOneHit(t, lintFor(t, grouped(total, "service")), "slo.group-unbounded", "/widgets/0/config/total")
		})
	}
	for _, total := range []string{
		`http_requests_total{service="api"}`,
		`http_requests_total{service=~"api|web"}`,
		`http_requests_total{region="eu", service="api"}`,
		`http_requests_total{service=~{{service}}}`,
	} {
		t.Run("bounds the groups: "+total, func(t *testing.T) {
			requireNoHits(t, lintFor(t, grouped(total, "service")), "slo.group-unbounded")
		})
	}
}

// The save path resolves the provider before the mutation lock, so a non-Prometheus objective is rejected by
// the same rule over HTTP, with the rule ID in the rejected save.
func TestSLOSummarySaveRejectsANonPrometheusProvider(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "tempo", URL: "http://127.0.0.1:1"})
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", []byte(sloProviderDocument(t, "metrics")), map[string]string{"If-None-Match": "*"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("save returned %d, want 400: %s", w.Code, w.Body)
	}
	var body rejectedSaveBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ruleIDs := make([]string, 0, len(body.Issues))
	for _, issue := range body.Issues {
		ruleIDs = append(ruleIDs, fmt.Sprint(issue["ruleId"]))
	}
	if !slices.Contains(ruleIDs, "slo.provider-type") {
		t.Fatalf("rejected save carries rules %v, want slo.provider-type", ruleIDs)
	}
}

// A provider lookup that does not return must not hold the mutation lock: other saves and deletes proceed while
// it waits, and the lookup is bounded so the save itself returns.
func TestSLOSummarySaveDoesNotHoldTheLockAcrossProviderLookup(t *testing.T) {
	arrived := make(chan struct{}, 1)
	release := make(chan struct{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case arrived <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer gateway.Close()
	defer close(release)
	s := observeTestService(t, gateway.URL)
	headers := observeHeaders("alice")
	headers["If-None-Match"] = "*"
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- request(t, s.Handler(), "PUT", "/api/dashboards/demo", []byte(sloProviderDocument(t, observeProviderID("prod/prom"))), headers)
	}()
	select {
	case <-arrived:
	case <-time.After(10 * time.Second):
		t.Fatal("the save never reached the provider lookup")
	}
	if !s.mutations.TryLock() {
		t.Fatal("a save holds the mutation lock while it waits on a provider lookup")
	}
	s.mutations.Unlock()
	select {
	case w := <-done:
		if w.Code != http.StatusOK && w.Code != http.StatusBadRequest {
			t.Fatalf("save returned %d after the bounded lookup: %s", w.Code, w.Body)
		}
	case <-time.After(sloProviderLookupTimeout + 10*time.Second):
		t.Fatal("the save did not return after its provider lookup bound")
	}
}

// Blanks between a label, its operator and its value are spaces, tabs, newlines or carriage returns. Config validation
// rejects a newline in a total, so this reads the selector directly to pin the blank handling.
func TestSelectorBoundsLabelSkipsEveryBlank(t *testing.T) {
	require.True(t, selectorBoundsLabel("http_requests_total{service\n=\"api\"}", "service"))
	require.True(t, selectorBoundsLabel("http_requests_total{service\r\n=~\r\n\"api|web\"}", "service"))
	require.True(t, selectorBoundsLabel("http_requests_total{service\t=\t\"api\"}", "service"))
	require.False(t, selectorBoundsLabel("http_requests_total{service\n!=\"api\"}", "service"))
}
