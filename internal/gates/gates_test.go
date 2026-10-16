package gates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestSmokeGate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		status     int
		timeout    int
		handler    http.HandlerFunc
		wantPassed bool
	}{
		{
			name:       "success",
			status:     http.StatusOK,
			timeout:    5,
			wantPassed: true,
		},
		{
			name:       "not found",
			status:     http.StatusNotFound,
			timeout:    5,
			wantPassed: false,
		},
		{
			name:    "timeout",
			status:  http.StatusOK,
			timeout: 1,
			handler: func(w http.ResponseWriter, _ *http.Request) {
				time.Sleep(2 * time.Second)
				w.WriteHeader(http.StatusOK)
			},
			wantPassed: false,
		},
		{
			name:       "default timeout",
			status:     http.StatusOK,
			timeout:    0,
			wantPassed: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			handler := tc.handler
			if handler == nil {
				handler = func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(tc.status)
				}
			}
			server := httptest.NewServer(handler)
			defer server.Close()

			gate := NewSmokeGate(server.Client())
			path := "/healthz"
			if tc.status == http.StatusNotFound {
				path = "/nonexistent"
			}
			result := gate.Execute(context.Background(), GateConfig{
				Type:     "smoke-test",
				Endpoint: server.URL + path,
				Timeout:  tc.timeout,
			})

			if result.Passed != tc.wantPassed {
				t.Fatalf("expected pass=%v, got pass=%v: %s", tc.wantPassed, result.Passed, result.Message)
			}
		})
	}
}

func TestSmokeGateRejectsRedirectWithoutProbingAnotherEnvironment(t *testing.T) {
	t.Parallel()
	var upstreamCalls, policyCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, upstream.URL, http.StatusFound)
	}))
	defer target.Close()
	client := target.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		policyCalls.Add(1)
		return nil
	}
	gate := NewSmokeGate(client)
	result := gate.Execute(context.Background(), GateConfig{Type: "smoke-test", Endpoint: target.URL, Timeout: 1})
	if result.Passed || result.Message != "HTTP 302 (expected 2xx)" || upstreamCalls.Load() != 0 {
		t.Fatalf("redirect incorrectly qualified target: %+v; upstream calls=%d", result, upstreamCalls.Load())
	}
	// The original caller retains its redirect policy for unrelated requests.
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target.URL, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if policyCalls.Load() != 1 || upstreamCalls.Load() != 1 {
		t.Fatal("smoke gate mutated caller's HTTP client")
	}
}

func TestDurationGate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		timeout    int
		setupCtx   func() (context.Context, context.CancelFunc)
		wantPassed bool
		maxElapsed time.Duration
	}{
		{
			name:       "waits",
			timeout:    1,
			wantPassed: true,
		},
		{
			name:    "default timeout respects parent context",
			timeout: 0,
			setupCtx: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 100*time.Millisecond)
			},
			maxElapsed: 2 * time.Second,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			ctx, cancel := context.WithCancel(context.Background())
			if tc.setupCtx != nil {
				ctx, cancel = tc.setupCtx()
			}
			defer cancel()

			gate := &DurationGate{}
			start := time.Now()
			result := gate.Execute(ctx, GateConfig{
				Type:    "duration",
				Timeout: tc.timeout,
			})
			elapsed := time.Since(start)

			if result.Passed != tc.wantPassed {
				t.Fatalf("expected pass=%v, got pass=%v: %s", tc.wantPassed, result.Passed, result.Message)
			}
			if tc.maxElapsed > 0 && elapsed > tc.maxElapsed {
				t.Fatalf("expected duration <= %v, got %v", tc.maxElapsed, elapsed)
			}
		})
	}
}

func TestExecuteGate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		cfg        GateConfig
		wantPassed bool
		wantMsg    string
	}{
		{
			name: "duration",
			cfg: GateConfig{
				Type:    "duration",
				Timeout: 1,
			},
			wantPassed: true,
		},
		{
			name: "unknown type",
			cfg: GateConfig{
				Type: "nonexistent",
			},
			wantPassed: false,
			wantMsg:    "unknown gate type: nonexistent",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			start := time.Now()
			result := ExecuteGate(context.Background(), tc.cfg)
			elapsed := time.Since(start)

			if result.Passed != tc.wantPassed {
				t.Fatalf("expected pass=%v, got pass=%v: %s", tc.wantPassed, result.Passed, result.Message)
			}
			if tc.wantMsg != "" && result.Message != tc.wantMsg {
				t.Fatalf("expected message %q, got %q", tc.wantMsg, result.Message)
			}
			if tc.cfg.Type == "duration" && elapsed < 900*time.Millisecond {
				t.Fatalf("expected at least 900ms wait, got %v", elapsed)
			}
		})
	}
}

func TestExecuteGate_SmokeViaDispatcher(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	result := ExecuteGate(context.Background(), GateConfig{
		Type:     "smoke-test",
		Endpoint: server.URL,
		Timeout:  5,
	})

	if !result.Passed {
		t.Fatalf("expected pass, got fail: %s", result.Message)
	}
}
