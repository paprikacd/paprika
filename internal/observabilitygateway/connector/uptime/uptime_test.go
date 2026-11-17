package uptime

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

const testOrg = "82bbc22b-0279-4f27-a404-bf30f96aee7d"
const testService = "ab64147d-1ffb-4850-916a-56b5146cb7ad"
const testTimestamp = "2026-10-27T01:02:03Z"

func testRequest(t *testing.T, endpoint, expression string) connector.QueryRequest {
	t.Helper()
	cfg, err := json.Marshal(map[string]any{"endpoint": endpoint, "orgId": testOrg})
	if err != nil {
		t.Fatal(err)
	}
	return connector.QueryRequest{Signal: connector.Signal("records"), Query: expression, Config: cfg, Credentials: []byte("test-bearer"), Range: connector.TimeRange{End: time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC)}}
}

func frameResult(t *testing.T, result *connector.QueryResult, err error) *dataframe.Frame {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.State != connector.StateOK {
		t.Fatalf("unexpected result: %#v", result)
	}
	frame, decodeErr := dataframe.Decode(result.Data)
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	return frame
}

func cell(t *testing.T, frame *dataframe.Frame, row int, key string) any {
	t.Helper()
	for index, column := range frame.Columns {
		if column.Key == key {
			return frame.Rows[row][index]
		}
	}
	t.Fatalf("missing column %s", key)
	return nil
}

func numberCell(t *testing.T, frame *dataframe.Frame, row int, key string) float64 {
	t.Helper()
	number, err := dataframe.Number(cell(t, frame, row, key))
	if err != nil {
		t.Fatal(err)
	}
	return number
}

func writeJSON(t *testing.T, w http.ResponseWriter, value string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	// #nosec G705 -- test-only JSON fixtures with explicit application/json content type.
	if _, err := io.WriteString(w, value); err != nil {
		t.Error(err)
	}
}

func fixture(path string) string {
	switch path {
	case servicesRPC:
		return `{"services":[{"id":"` + testService + `","name":"Checkout","slug":"checkout","url":"hidden-address"}],"pageInfo":{}}`
	case checksRPC:
		return `{"summaries":[{"check":{"id":"check-1","name":"HTTP","type":"CHECK_TYPE_UPTIME","enabled":true,"config":{"secret":"hidden-secret"}},"serviceId":"` + testService + `","serviceName":"Checkout","latestStatus":"CHECK_STATUS_SUCCESS","latestResultAt":"` + testTimestamp + `","latestResponseTimeMs":12}]}`
	case securityRPC:
		return `{"summaries":[{"serviceId":"` + testService + `","serviceName":"Checkout","checkId":"security-1","checkEnabled":true,"latestResultAt":"` + testTimestamp + `","overallScore":92,"riskLevel":"low","findingCount":2,"highRiskFindingCount":0,"observedSignalCount":8,"supportedSignalCount":9,"topFinding":{"raw":"hidden-security-payload"}}]}`
	case alertsRPC:
		return `{"events":[{"id":"event-1","alertId":"alert-1","status":"ALERT_EVENT_STATUS_TRIGGERED","triggeredAt":"` + testTimestamp + `","alert":{"name":"Latency alert","checkId":"check-1","channels":[{"token":"hidden-channel-token"}]}},{"id":"resolved","status":"ALERT_EVENT_STATUS_RESOLVED"}]}`
	case sloRPC:
		return `{"services":[{"serviceId":"` + testService + `","serviceName":"Checkout","serviceSlug":"checkout","slaTarget":99.9,"currentUptime":99.95,"errorBudgetTotal":43.2,"errorBudgetRemaining":21.6,"errorBudgetPercentage":50,"slaBreached":false,"totalChecks":2000,"failedChecks":1}]}`
	case reliabilityRPC:
		return `{"latestReport":{"id":"report-1","orgId":"` + testOrg + `","summary":"Service reliability is stable.","overallHealthScore":94,"periodStart":"2026-10-20T00:00:00Z","periodEnd":"` + testTimestamp + `","generatedAt":"` + testTimestamp + `","insights":[{"id":"insight-1","category":"performance","severity":"warning","title":"Review latency","description":"Tail latency increased.","recommendation":"Inspect the slow route.","affectedServices":["Checkout"],"generatedAt":"` + testTimestamp + `"}]}}`
	default:
		return `{}`
	}
}

func TestReadOperationsUseFixedConnectRequests(t *testing.T) {
	operations := []struct {
		operation string
		paths     []string
		rows      int
	}{
		{"services", []string{servicesRPC}, 1}, {"check_summaries", []string{checksRPC}, 1},
		{"security_summaries", []string{securityRPC}, 1}, {"alert_events", []string{alertsRPC}, 1},
		{"overview", []string{servicesRPC, checksRPC, securityRPC, alertsRPC}, 1},
		{"service_signals", []string{servicesRPC, checksRPC, securityRPC}, 1},
		{"slo", []string{sloRPC}, 1}, {"slo_summary", []string{sloRPC}, 1},
		{"reliability_insights", []string{servicesRPC, reliabilityRPC}, 1},
		{"reliability_summary", []string{servicesRPC, reliabilityRPC}, 1},
	}
	for _, test := range operations {
		t.Run(test.operation, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				index := int(calls.Add(1)) - 1
				if index >= len(test.paths) || r.URL.Path != test.paths[index] {
					t.Errorf("unexpected path %s", r.URL.Path)
				}
				assertConnectRequest(t, r, test.operation)
				writeJSON(t, w, fixture(r.URL.Path))
			}))
			defer server.Close()
			result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"`+test.operation+`"}`))
			frame := frameResult(t, result, err)
			if len(frame.Rows) != test.rows || int(calls.Load()) != len(test.paths) {
				t.Errorf("rows/calls: %d/%d", len(frame.Rows), calls.Load())
			}
			if strings.Contains(string(result.Data), "hidden-") {
				t.Error("unselected source payload leaked")
			}
		})
	}
}

func TestRejectsQueriesBeforeBackendAccess(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); writeJSON(t, w, `{}`) }))
	defer server.Close()
	queries := []string{
		`{"operation":"services","operation":"slo"}`,
		`{"operation":"GenerateReliabilityInsights"}`, `{"operation":"DeleteService"}`,
		`{"operation":"services","args":{"orgId":"` + testOrg + `"}}`,
		`{"operation":"services","args":{"limit":101}}`, `{"operation":"services","args":{"limit":0}}`,
		`{"operation":"services","args":{"windowDays":30}}`, `{"operation":"slo","args":{"windowDays":365}}`,
		`{"operation":"slo","args":{"breachedOnly":"true"}}`, `{"operation":"overview","args":{"breachedOnly":true}}`,
		`{"operation":"services","args":{"serviceId":"../../secret"}}`,
		`{"operation":"reliability_summary","args":{"serviceId":"` + testService + `"}}`,
		`{"operation":"services","projection":{"value":"score"}}`,
		`{"operation":"services","endpoint":"https://elsewhere.invalid"}`, `{"operation":"services"}{}`,
	}
	for _, expression := range queries {
		if _, err := New().Query(context.Background(), testRequest(t, server.URL, expression)); err == nil {
			t.Errorf("accepted invalid query: %s", expression)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid query reached backend")
	}
}

func TestProjectionAndOptionalNull(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, fixture(checksRPC)) }))
	defer server.Close()
	req := testRequest(t, server.URL, `{"operation":"check_summaries","projection":{"value":"responseTimeMs","time":"observedAt","labels":["serviceId","checkId"]}}`)
	req.Signal = connector.SignalMetrics
	result, err := New().Query(context.Background(), req)
	if err != nil || result.State != connector.StateOK {
		t.Fatalf("project metrics: %#v %v", result, err)
	}
	var wire struct {
		Data struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				Values [][2]any          `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(result.Data, &wire); decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if wire.Data.ResultType != "matrix" || len(wire.Data.Result) != 1 {
		t.Fatalf("bad matrix: %s", result.Data)
	}
	series := wire.Data.Result[0]
	observed, parseErr := time.Parse(time.RFC3339, testTimestamp)
	if parseErr != nil {
		t.Fatal(parseErr)
	}
	if len(series.Values) != 1 || series.Values[0][0] != float64(observed.Unix()) || series.Values[0][1] != "12" || series.Metric["serviceId"] != testService {
		t.Fatalf("projection altered source: %s", result.Data)
	}
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, `{"summaries":[{"check":{"id":"waiting"},"serviceId":"`+testService+`"}]}`)
	}))
	defer missing.Close()
	result, err = New().Query(context.Background(), testRequest(t, missing.URL, `{"operation":"check_summaries"}`))
	frame := frameResult(t, result, err)
	for _, key := range []string{"status", "observedAt", "responseTimeMs"} {
		if cell(t, frame, 0, key) != nil {
			t.Errorf("missing %s was synthesized", key)
		}
	}
}

func TestReliabilityRequiresOrgAccessAndMatchesOrg(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != servicesRPC {
					t.Error("reliability queried before org authorization")
				}
				w.WriteHeader(status)
				writeJSON(t, w, `{"message":"hidden-denial-secret"}`)
			}))
			defer server.Close()
			result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"reliability_insights"}`))
			if err != nil || result.State != connector.StateForbidden || calls.Load() != 1 {
				t.Fatalf("incorrect denial: %#v %v", result, err)
			}
			if strings.Contains(result.Reason, "hidden-") {
				t.Fatal("response leaked")
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == servicesRPC {
			writeJSON(t, w, `{}`)
			return
		}
		writeJSON(t, w, `{"latestReport":{"id":"wrong-org","orgId":"other"}}`)
	}))
	defer server.Close()
	result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"reliability_summary"}`))
	if err != nil || result.State != connector.StateError || len(result.Data) != 0 {
		t.Fatalf("cross-org report accepted: %#v %v", result, err)
	}
}

func TestCapsAndPartialOverview(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == servicesRPC {
			writeJSON(t, w, `{"services":[{"id":"one"},{"id":"two"}],"pageInfo":{"hasNextPage":true,"totalCount":3}}`)
			return
		}
		writeJSON(t, w, fixture(r.URL.Path))
	}))
	defer server.Close()
	result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"overview","args":{"limit":1}}`))
	frame := frameResult(t, result, err)
	if !frame.Truncated || cell(t, frame, 0, "serviceCount") != nil || numberCell(t, frame, 0, "loadedServiceCount") != 1 {
		t.Fatalf("partial counts were represented as complete: %s", result.Data)
	}
	result, err = New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"services","args":{"limit":1}}`))
	frame = frameResult(t, result, err)
	if len(frame.Rows) != 1 || !frame.Truncated {
		t.Fatal("row cap not applied")
	}
}

func TestSLOMissingObservationsAndSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, `{"services":[{"serviceId":"empty","slaTarget":99.9,"currentUptime":0,"totalChecks":0,"slaBreached":true},{"serviceId":"observed","totalChecks":10,"currentUptime":99,"errorBudgetPercentage":50,"slaBreached":true}]}`)
	}))
	defer server.Close()
	result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"slo","args":{"windowDays":7}}`))
	frame := frameResult(t, result, err)
	for _, key := range []string{"uptime", "slaBreached", "burnRate", "errorBudgetRemaining"} {
		if cell(t, frame, 0, key) != nil {
			t.Errorf("no-data %s is not null", key)
		}
	}
	if cell(t, frame, 1, "burnStatus") != "Critical" {
		t.Error("source burn normalization not preserved")
	}
	result, err = New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"slo_summary"}`))
	frame = frameResult(t, result, err)
	if numberCell(t, frame, 0, "averageUptime") != 99 || numberCell(t, frame, 0, "unobservedServiceCount") != 1 {
		t.Error("summary includes unobserved service as zero")
	}
	result, err = New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"slo","args":{"breachedOnly":true}}`))
	frame = frameResult(t, result, err)
	if len(frame.Rows) != 1 || cell(t, frame, 0, "serviceId") != "observed" {
		t.Error("active breaches include unobserved or healthy services")
	}
}

func TestRefusesRedirectsAndBoundsResponses(t *testing.T) {
	var forwarded atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { forwarded.Add(1); writeJSON(t, w, `{}`) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	result, err := New().Query(context.Background(), testRequest(t, redirect.URL, `{"operation":"services"}`))
	if err != nil || result.State != connector.StateError || forwarded.Load() != 0 {
		t.Fatal("redirect was followed")
	}
	large := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, `{"padding":"`+strings.Repeat("x", maxResponseBytes)+`"}`)
	}))
	defer large.Close()
	result, err = New().Query(context.Background(), testRequest(t, large.URL, `{"operation":"services"}`))
	if err != nil || result.State != connector.StateError {
		t.Fatal("oversized body accepted")
	}
}

func TestCancellationAndMissingCredential(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	req := testRequest(t, server.URL, `{"operation":"services"}`)
	req.Credentials = nil
	result, err := New().Query(context.Background(), req)
	if err != nil || result.State != connector.StateNotConfigured || calls.Load() != 0 {
		t.Fatal("missing credential reached backend")
	}
	req.Credentials = []byte("test-bearer")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	result, err = New().Query(ctx, req)
	if err != nil || result.State != connector.StateError || time.Since(start) > time.Second {
		t.Fatal("cancellation did not bound query")
	}
}

func TestConfigAndEmptyReports(t *testing.T) {
	for _, raw := range []string{`{}`, `{"endpoint":"https://example.invalid"}`, `{"endpoint":"https://example.invalid","orgId":"invalid"}`, `{"endpoint":"https://example.invalid","orgId":"` + testOrg + `","token":"hidden"}`, `{"endpoint":"https://example.invalid","orgId":"` + testOrg + `","headers":{"Authorization":"hidden"}}`} {
		if err := New().ValidateConfig(json.RawMessage(raw)); err == nil {
			t.Errorf("invalid config accepted %s", raw)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(t, w, `{}`) }))
	defer server.Close()
	for _, operation := range []string{"reliability_summary", "reliability_insights"} {
		result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"`+operation+`"}`))
		frame := frameResult(t, result, err)
		if len(frame.Rows) != 0 {
			t.Error("missing report produced synthetic data")
		}
	}
}

func assertConnectRequest(t *testing.T, r *http.Request, operation string) {
	t.Helper()
	if r.Method != http.MethodPost || r.Header.Get("Connect-Protocol-Version") != "1" || r.Header.Get("Content-Type") != "application/json" {
		t.Error("incorrect Connect request")
	}
	if r.Header.Get("Authorization") != "Bearer test-bearer" {
		t.Error("bearer missing")
	}
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Error(err)
	}
	if body["orgId"] != testOrg {
		t.Error("organization missing")
	}
	wantFields := 1
	switch r.URL.Path {
	case servicesRPC, checksRPC, securityRPC, alertsRPC:
		wantFields++
		page, ok := body["page"].(map[string]any)
		if !ok {
			t.Error("missing page")
			break
		}
		wantLimit := float64(100)
		if strings.HasPrefix(operation, "reliability_") {
			wantLimit = 1
		}
		if page["pageSize"] != wantLimit || len(page) != 1 {
			t.Errorf("incorrect page: %#v", page)
		}
	case sloRPC:
		wantFields++
		if body["windowDays"] != float64(30) {
			t.Error("missing SLO window")
		}
	}
	if r.URL.Path == alertsRPC {
		wantFields++
		if body["statusFilter"] != "ALERT_EVENT_STATUS_TRIGGERED" {
			t.Error("incorrect alert filter")
		}
	}
	if len(body) != wantFields {
		t.Errorf("unexpected request fields %#v", body)
	}

}
