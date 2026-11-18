package insights

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// promBody builds a Prometheus matrix response with n series of one point each.
func promBody(t *testing.T, n int, warnings []string, truncated bool) []byte {
	t.Helper()
	result := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		result = append(result, map[string]any{"metric": map[string]string{"__name__": "up", "i": strconv.Itoa(i)}, "values": [][]any{{100, "1"}}})
	}
	body, err := json.Marshal(map[string]any{"status": "success", "warnings": warnings, "truncated": truncated, "data": map[string]any{"resultType": "matrix", "result": result}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// promPoints builds one series with n points, to exercise the per-series cap.
func promPoints(t *testing.T, n int) []byte {
	t.Helper()
	values := make([][]any, 0, n)
	for i := 0; i < n; i++ {
		values = append(values, []any{i, "1"})
	}
	body, err := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": []map[string]any{{"metric": map[string]string{"__name__": "up"}, "values": values}}}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// tempoBody builds a Tempo search response with n traces.
func tempoBody(t *testing.T, n int, completed, total int, warnings []string, truncated bool) []byte {
	t.Helper()
	traces := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		traces = append(traces, map[string]any{"traceID": "a", "rootServiceName": "svc", "rootTraceName": "op", "startTimeUnixNano": "1000000000", "durationMs": 1})
	}
	body, err := json.Marshal(map[string]any{"traces": traces, "warnings": warnings, "truncated": truncated, "metrics": map[string]int{"completedJobs": completed, "totalJobs": total}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDecodePrometheusTruncationReasons(t *testing.T) {
	// The direct path asks Prometheus for maxSeries+1; the shared path asks for maxSeries.
	direct, shared := maxSeries+1, maxSeries
	cases := []struct {
		name      string
		body      []byte
		requested int
		reason    string
		limit     int
		unit      string
		trunc     bool
	}{
		{"direct 100 series with a warning is provider_warning", promBody(t, 100, []string{"w"}, false), direct, "provider_warning", 0, "series", true},
		{"shared 100 series with a warning fills the request and is row_limit", promBody(t, 100, []string{"w"}, false), shared, "row_limit", 100, "series", true},
		{"shared 100 series with a source partial flag is row_limit", promBody(t, 100, nil, true), shared, "row_limit", 100, "series", true},
		{"101 series is cut to row_limit", promBody(t, 101, nil, false), direct, "row_limit", 100, "series", true},
		{"2 series with a non-limit warning is provider_warning", promBody(t, 2, []string{"PromQL warning: mix of histograms and floats"}, false), direct, "provider_warning", 0, "series", true},
		{"2 series, complete, is not truncated", promBody(t, 2, nil, false), direct, "", 0, "", false},
		{"source truncated flag with few series is partial", promBody(t, 2, nil, true), direct, "partial", 0, "series", true},
		{"per-series point cap is row_limit in points", promPoints(t, maxPoints+1), direct, "row_limit", maxPoints, "points", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := decodePrometheus(tc.body, tc.requested)
			if err != nil {
				t.Fatal(err)
			}
			if result.Truncated != tc.trunc {
				t.Fatalf("Truncated = %v, want %v", result.Truncated, tc.trunc)
			}
			if tc.reason == "" {
				if result.Truncation != nil {
					t.Fatalf("Truncation = %+v, want nil", result.Truncation)
				}
				return
			}
			if result.Truncation == nil || result.Truncation.Reason != tc.reason || result.Truncation.Limit != tc.limit || result.Truncation.Unit != tc.unit {
				t.Fatalf("Truncation = %+v, want reason %s limit %d unit %s", result.Truncation, tc.reason, tc.limit, tc.unit)
			}
		})
	}
}

func TestDecodeTempoTruncationReasons(t *testing.T) {
	// The direct search asks for maxTraces+1; the shared path asks for maxTraces.
	direct, shared := maxTraces+1, maxTraces
	cases := []struct {
		name      string
		body      []byte
		requested int
		reason    string
		unit      string
		trunc     bool
	}{
		{"101 traces with complete jobs is row_limit", tempoBody(t, 101, 3, 3, nil, false), direct, "row_limit", "traces", true},
		{"101 traces with partial jobs is row_limit", tempoBody(t, 101, 2, 3, nil, false), direct, "row_limit", "traces", true},
		{"3 traces with partial jobs is partial", tempoBody(t, 3, 2, 3, nil, false), direct, "partial", "traces", true},
		{"3 traces with a gateway truncated envelope is partial", tempoBody(t, 3, 3, 3, nil, true), shared, "partial", "traces", true},
		{"100 traces with a gateway truncated envelope is row_limit", tempoBody(t, 100, 3, 3, nil, true), shared, "row_limit", "traces", true},
		{"direct 100 traces with a warning is provider_warning", tempoBody(t, 100, 3, 3, []string{"w"}, false), direct, "provider_warning", "traces", true},
		{"shared 100 traces with a warning is row_limit", tempoBody(t, 100, 3, 3, []string{"w"}, false), shared, "row_limit", "traces", true},
		{"3 traces with a warning is provider_warning", tempoBody(t, 3, 3, 3, []string{"w"}, false), direct, "provider_warning", "traces", true},
		{"3 clean traces is not truncated", tempoBody(t, 3, 3, 3, nil, false), direct, "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := decodeTempo(tc.body, tc.requested)
			if err != nil {
				t.Fatal(err)
			}
			if result.Truncated != tc.trunc {
				t.Fatalf("Truncated = %v, want %v", result.Truncated, tc.trunc)
			}
			if tc.reason == "" {
				if result.Truncation != nil {
					t.Fatalf("Truncation = %+v, want nil", result.Truncation)
				}
				return
			}
			if result.Truncation == nil || result.Truncation.Reason != tc.reason || result.Truncation.Unit != tc.unit {
				t.Fatalf("Truncation = %+v, want reason %s unit %s", result.Truncation, tc.reason, tc.unit)
			}
			if tc.reason == "row_limit" && result.Truncation.Limit != maxTraces {
				t.Fatalf("row_limit Limit = %d, want %d", result.Truncation.Limit, maxTraces)
			}
		})
	}
}

// A capped page whose warning also fires is still reported as the first N.
func TestRowLimitEvidenceTakesPrecedence(t *testing.T) {
	result, err := decodeTempo(tempoBody(t, 100, 1, 3, []string{"w"}, false), maxTraces)
	if err != nil {
		t.Fatal(err)
	}
	if result.Truncation == nil || result.Truncation.Reason != truncationRowLimit {
		t.Fatalf("Truncation = %+v, want row_limit", result.Truncation)
	}
	encoded, err := json.Marshal(result.Truncation)
	if err != nil || !strings.Contains(string(encoded), `"reason":"row_limit"`) {
		t.Fatalf("row_limit must serialise its reason, got %s", encoded)
	}
}

func TestQueryReceiptNamesTruncationReason(t *testing.T) {
	var diagnostics QueryDiagnostics
	diagnostics.complete(&QueryResult{Truncated: true, Truncation: &QueryTruncation{Reason: truncationPartial, Unit: "traces"}}, nil)
	if diagnostics.Outcome != "partial" || !diagnostics.Truncated || diagnostics.TruncationReason != truncationPartial {
		t.Fatalf("receipt = outcome %q truncated %v reason %q", diagnostics.Outcome, diagnostics.Truncated, diagnostics.TruncationReason)
	}
	var complete QueryDiagnostics
	complete.complete(&QueryResult{}, nil)
	if complete.TruncationReason != "" {
		t.Fatalf("complete receipt reason = %q, want empty", complete.TruncationReason)
	}
}

func TestDashboardSignalCarriesProviderTruncationReason(t *testing.T) {
	signal := summarizeDashboardResult(&QueryResult{Series: []Series{{Name: "up", Points: []Point{{Timestamp: 1}}}}, Truncated: true, Truncation: &QueryTruncation{Reason: truncationRowLimit, Limit: maxSeries, Unit: "series"}}, DashboardSummaryOptions{})
	if !signal.ProviderTruncated || signal.ProviderTruncation != truncationRowLimit {
		t.Fatalf("signal providerTruncation = %q (providerTruncated %v), want row_limit", signal.ProviderTruncation, signal.ProviderTruncated)
	}
	complete := summarizeDashboardResult(&QueryResult{}, DashboardSummaryOptions{})
	if complete.ProviderTruncation != "" {
		t.Fatalf("complete signal providerTruncation = %q, want empty", complete.ProviderTruncation)
	}
}

func TestProviderTruncationLintMessageNamesReason(t *testing.T) {
	if msg := providerTruncationMessage(truncationRowLimit); !strings.Contains(msg, "row limit") {
		t.Fatalf("row_limit message = %q", msg)
	}
	if msg := providerTruncationMessage(truncationPartial); strings.Contains(msg, "row limit") {
		t.Fatalf("partial message = %q must not name a row limit", msg)
	}
}

// A Tempo search that rejects limit=101 is retried at the normal bound. A full
// fallback page is a row cap, not a provider warning.
func TestTempoFallbackPageNamesRowLimit(t *testing.T) {
	full := tempoBody(t, maxTraces, 1, 1, nil, false)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == strconv.Itoa(maxTraces+1) {
			http.Error(w, "limit too large", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(full)
	}))
	defer upstream.Close()
	p, err := newProvider(&ProviderConfig{ID: "traces", Name: "Traces", Type: "tempo", URL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	result, err := p.query(context.Background(), &Query{ProviderID: "traces", Query: "{}", Kind: "traces", Start: 1000, End: 2000})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || result.Truncation == nil || result.Truncation.Reason != truncationRowLimit || result.Truncation.Unit != "traces" || result.Truncation.Limit != maxTraces {
		t.Fatalf("fallback full page = truncated %v, truncation %+v; want a traces row_limit", result.Truncated, result.Truncation)
	}
}

// A truncated records frame is a known row limit only when it is a full page.
// A shorter one, whether a connector's own cap or a downsampled source, has no
// known reason and must not be named partial.
func TestRecordsFrameTruncationReasons(t *testing.T) {
	rows := func(n int) [][]any {
		out := make([][]any, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, []any{float64(i)})
		}
		return out
	}
	cases := []struct {
		name   string
		rows   int
		reason string
		limit  int
	}{
		// An empty or short truncated frame has no known reason: a connector's own
		// query limit is below MaxRows, so it is not a partial source.
		{"an empty truncated frame has no reason", 0, "", 0},
		{"a 3-row truncated frame has no reason", 3, "", 0},
		{"a 100-row connector page has no reason", 100, "", 0},
		{"a 999-row truncated frame has no reason", dataframe.MaxRows - 1, "", 0},
		{"a full page is row_limit", dataframe.MaxRows, truncationRowLimit, dataframe.MaxRows},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(dataframe.Frame{Columns: []dataframe.Column{{Key: "value", Type: "number"}}, Rows: rows(tc.rows), Truncated: true})
			if err != nil {
				t.Fatal(err)
			}
			result, err := decodeObserveQuery("records", body)
			if err != nil {
				t.Fatal(err)
			}
			if !result.Truncated {
				t.Fatalf("records truncated flag was dropped: %+v", result)
			}
			if tc.reason == "" {
				if result.Truncation != nil {
					t.Fatalf("records truncation = %+v; want none (unknown reason)", result.Truncation)
				}
				return
			}
			if result.Truncation == nil || result.Truncation.Reason != tc.reason || result.Truncation.Limit != tc.limit || result.Truncation.Unit != "rows" {
				t.Fatalf("records truncation = %+v; want %s limit %d rows", result.Truncation, tc.reason, tc.limit)
			}
		})
	}
}
