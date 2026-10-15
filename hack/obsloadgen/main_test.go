package main

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCallClassifiesCompletedResponses(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"success", 200, `{"result":{"structuredContent":{"state":"OK"}}}`, ""},
		{"list success", 200, `{"result":{"structuredContent":{"providers":[]}}}`, ""},
		{"tool error", 200, `{"result":{"isError":true}}`, "tool_error"},
		{"provider failure", 200, `{"result":{"structuredContent":{"state":"Forbidden"}}}`, "tool_Forbidden"},
		{"rpc error", 200, `{"error":{"code":-32602,"message":"invalid"}}`, "rpc_error"},
		{"http throttle", 429, `{}`, "http_429"},
		{"malformed", 200, `{`, "decode"},
		{"empty envelope", 200, `{}`, "missing_result"},
		{"null result", 200, `{"result":null}`, "missing_result"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()
			latency, n, class := call(context.Background(), srv.Client(), srv.URL, "synthetic-token", "query_metrics", nil)
			if class != tc.want || n != len(tc.body) || latency <= 0 {
				t.Fatalf("got class=%q bytes=%d latency=%s; want class=%q bytes=%d and positive completed latency", class, n, latency, tc.want, len(tc.body))
			}
		})
	}
}

func TestCallLatencyIncludesBodyRead(t *testing.T) {
	t.Parallel()
	const delay = 60 * time.Millisecond
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(delay)
		_, _ = io.WriteString(w, `{"result":{}}`)
	}))
	defer srv.Close()
	latency, _, class := call(context.Background(), srv.Client(), srv.URL, "synthetic-token", "list_observability_providers", nil)
	if class != "" || latency < delay {
		t.Fatalf("body completion missing from latency: class=%q latency=%s delay=%s", class, latency, delay)
	}
}

func TestCallDetectsOversizedBodyInsteadOfAcceptingValidPrefix(t *testing.T) {
	t.Parallel()
	// A complete JSON prefix followed by whitespace previously looked like
	// success when LimitReader silently discarded the rest of the response.
	body := `{"result":{}}` + strings.Repeat(" ", 200)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, body)
	}))
	defer srv.Close()
	_, n, class := callWithLimit(context.Background(), srv.Client(), srv.URL, "synthetic-token", "query_metrics", nil, 64)
	if class != "response_too_large" || n != 65 {
		t.Fatalf("got class=%q bytes=%d; want oversized response detected with one-byte probe", class, n)
	}
}

func TestCallBodyReadHonorsDeadline(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	latency, _, class := call(ctx, srv.Client(), srv.URL, "synthetic-token", "query_logs", nil)
	if class != "timeout" || latency < 20*time.Millisecond {
		t.Fatalf("deadline not classified during body read: class=%q latency=%s", class, latency)
	}
}

func TestWaitUntilIsCancelable(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitUntil(ctx, time.Now().Add(time.Hour)) {
		t.Fatal("canceled pacing must stop immediately")
	}
}

func TestReserveCallBoundsConcurrentSamples(t *testing.T) {
	t.Parallel()
	var total, reserved atomic.Int64
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			for reserveCall(&total, 101) {
				reserved.Add(1)
			}
		})
	}
	wg.Wait()
	if total.Load() != 101 || reserved.Load() != 101 {
		t.Fatalf("call limit exceeded or undershot: total=%d reserved=%d", total.Load(), reserved.Load())
	}
}

func TestParseMixRejectsMisleadingWorkloads(t *testing.T) {
	t.Parallel()
	for _, mix := range []string{"", "query_metrics", ":1", "unknown:1", "query_metrics:0", "query_metrics:-1", "query_metrics:1trailing", "query_metrics:1000001", "query_metrics:1000000,query_logs:1", "query_metrics:1,query_metrics:2"} {
		if _, err := parseMix(mix); err == nil {
			t.Errorf("accepted invalid mix %q", mix)
		}
	}
	tools, err := parseMix(" query_metrics : 2 , query_logs:1 ")
	if err != nil || len(tools) != 2 || tools[0].weight != 2 || tools[1].name != "query_logs" {
		t.Fatalf("valid mix: tools=%v err=%v", tools, err)
	}
}

func TestParseProviders(t *testing.T) {
	t.Parallel()
	for _, input := range []string{"", "obs/", "/prom", "prom", "obs/prom/extra", "obs/a,", "obs/space name"} {
		if _, err := parseProviders(input); err == nil {
			t.Errorf("accepted invalid provider list %q", input)
		}
	}
	providers, err := parseProviders(" obs/prom , obs/logs ")
	if err != nil || len(providers) != 2 || providers[0] != "obs/prom" {
		t.Fatalf("valid providers: %v err=%v", providers, err)
	}
}

func TestOptionsRejectUnsafeBounds(t *testing.T) {
	t.Parallel()
	valid := options{"http://127.0.0.1:18090", 2, 1, 5, time.Second, 100}
	if err := valid.validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*options){
		func(o *options) { o.clients = 0 },
		func(o *options) { o.clients = 257 },
		func(o *options) { o.secs = -1 },
		func(o *options) { o.secs = 3601 },
		func(o *options) { o.rps = -1 },
		func(o *options) { o.rps = 1e-10 },
		func(o *options) { o.rps = math.NaN() },
		func(o *options) { o.rps = math.Inf(1) },
		func(o *options) { o.rps = 1001 },
		func(o *options) { o.timeout = 0 },
		func(o *options) { o.timeout = 6 * time.Minute },
		func(o *options) { o.maxCalls = 0 },
		func(o *options) { o.maxCalls = 1000001 },
		func(o *options) { o.gateway = "file:///tmp/socket" },
		func(o *options) { o.gateway = "http://user:password@localhost" },
		func(o *options) { o.gateway = "http://localhost?token=unsafe" },
	} {
		o := valid
		mutate(&o)
		if err := o.validate(); err == nil {
			t.Errorf("accepted invalid options %+v", o)
		}
	}
}

func TestReportSeparatesSuccessAndUsesNearestRank(t *testing.T) {
	t.Parallel()
	stats := [][]callStats{{
		{tool: "query_metrics", latency: time.Millisecond, bytes: 10},
		{tool: "query_metrics", latency: 2 * time.Millisecond, bytes: 20, err: "tool_error"},
	}}
	r := buildReport([]toolSpec{{"query_metrics", 1}, {"query_logs", 1}}, stats, time.Second, 1, 5)
	if r.TotalCalls != 2 || r.SuccessfulCalls != 1 || r.SuccessfulCallsPerSec != 1 || r.Errors["tool_error"] != 1 || r.ByTool["query_metrics"].Errors != 1 || r.BytesTotal != 30 {
		t.Fatalf("incorrect report: %+v", r)
	}
	if _, ok := r.ByTool["query_logs"]; !ok {
		t.Fatal("unused configured tool missing from report")
	}
	if got := percentile([]time.Duration{1, 2, 3, 4}, 0.51); got != 3 {
		t.Fatalf("nearest rank should ceil(4*0.51)=3; got %s", got)
	}
}
