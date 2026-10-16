package gates

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type executorTestTransport func(*http.Request) (*http.Response, error)

func (f executorTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestExecutorDurationDoesNotSendHTTP(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	executor := NewExecutor(&http.Client{Transport: executorTestTransport(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, errors.New("duration gate must not send HTTP")
	})})

	start := time.Now()
	result := executor.Execute(context.Background(), GateConfig{Type: "duration", Timeout: 1})
	if !result.Passed || result.Error != nil || result.Message != "waited 1 seconds" {
		t.Fatalf("duration gate with no endpoint failed: %+v", result)
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Fatalf("duration gate passed before the configured wait: %v", elapsed)
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("duration gate sent %d HTTP requests", got)
	}
}

func TestExecutorDurationRespectsCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	result := NewExecutor(nil).Execute(ctx, GateConfig{Type: "duration", Timeout: 1})
	if result.Passed || !errors.Is(result.Error, context.DeadlineExceeded) {
		t.Fatalf("cancelled duration gate did not fail closed: %+v", result)
	}
}

func TestExecutorSmokeUsesConfiguredClient(t *testing.T) {
	t.Parallel()

	for _, status := range []int{http.StatusOK, http.StatusNoContent, http.StatusServiceUnavailable, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()

			var requests atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				requests.Add(1)
				if req.Method != http.MethodGet || req.URL.Path != "/healthz" || req.Header.Get("X-Gate-Client") != "configured" {
					t.Error("smoke gate did not retain the configured client request")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.WriteHeader(status)
			}))
			defer server.Close()

			customClient := server.Client()
			transport := customClient.Transport
			customClient.Transport = executorTestTransport(func(req *http.Request) (*http.Response, error) {
				req = req.Clone(req.Context())
				req.Header.Set("X-Gate-Client", "configured")
				return transport.RoundTrip(req)
			})
			result := NewExecutor(customClient).Execute(context.Background(), GateConfig{
				Type:     "smoke-test",
				Endpoint: server.URL + "/healthz",
				Timeout:  5,
			})

			if wantPassed := status >= 200 && status < 300; result.Passed != wantPassed || result.Error != nil {
				t.Fatalf("HTTP %d gate result = %+v, want passed=%v", status, result, wantPassed)
			}
			if got := requests.Load(); got != 1 {
				t.Fatalf("smoke gate sent %d requests, want exactly one", got)
			}
		})
	}
}

func TestExecutorUnknownTypeFailsWithoutHTTP(t *testing.T) {
	t.Parallel()

	var requests atomic.Int32
	executor := NewExecutor(&http.Client{Transport: executorTestTransport(func(*http.Request) (*http.Response, error) {
		requests.Add(1)
		return nil, errors.New("unknown gate must not send HTTP")
	})})
	for _, gateType := range []string{"", "unsupported"} {
		result := executor.Execute(context.Background(), GateConfig{
			Type:     gateType,
			Endpoint: "https://example.invalid/healthz",
		})
		if result.Passed || result.Message != "unknown gate type: "+gateType {
			t.Fatalf("unsupported gate type %q did not fail closed: %+v", gateType, result)
		}
	}
	if got := requests.Load(); got != 0 {
		t.Fatalf("unknown gates sent %d HTTP requests", got)
	}
}
