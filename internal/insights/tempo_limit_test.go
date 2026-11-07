package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestDirectTempoSearchLimitSignals(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		count                      int
		rejectProbe, wantTruncated bool
	}{
		{"below", 99, false, false},
		{"exact", 100, false, false},
		{"more", 101, false, true},
		{"fallback full", 101, true, true},
		{"fallback short", 99, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []int{}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
				if err != nil {
					t.Fatal(err)
				}
				calls = append(calls, limit)
				if tc.rejectProbe && limit == 101 {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				traces := make([]map[string]any, min(tc.count, limit))
				for i := range traces {
					traces[i] = map[string]any{"traceID": fmt.Sprintf("%032x", i+1), "rootServiceName": "api", "startTimeUnixNano": "1700000000123000000", "durationMs": 42}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"traces": traces})
			}))
			defer upstream.Close()
			s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
			w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"tempo","kind":"traces","query":"{}","start":1700000000,"end":1700000600,"step":0}`), nil)
			if w.Code != 200 {
				t.Fatalf("query: %d %s", w.Code, w.Body)
			}
			var result QueryResult
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result.Traces) != min(tc.count, 100) || result.Truncated != tc.wantTruncated {
				t.Fatalf("unexpected bounded result: traces=%d truncated=%v", len(result.Traces), result.Truncated)
			}
			if calls[0] != 101 || (tc.rejectProbe && (len(calls) != 2 || calls[1] != 100)) || (!tc.rejectProbe && len(calls) != 1) {
				t.Fatalf("unexpected requests: %v", calls)
			}
		})
	}
}

func TestDirectTempoUnauthorizedDoesNotRetryProbe(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(http.StatusUnauthorized) }))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "tempo", Name: "Traces", Type: "tempo", URL: upstream.URL})
	w := request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"tempo","kind":"traces","query":"{}","start":1700000000,"end":1700000600,"step":0}`), nil)
	if w.Code != http.StatusBadGateway || calls != 1 {
		t.Fatalf("unexpected failure behavior: status=%d calls=%d", w.Code, calls)
	}
}
