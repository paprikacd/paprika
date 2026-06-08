package gates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSmokeGate_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	gate := NewSmokeGate()
	result := gate.Execute(context.Background(), GateConfig{
		Type:     "smoke-test",
		Endpoint: server.URL + "/healthz",
		Timeout:  5,
	})

	if !result.Passed {
		t.Fatalf("expected pass, got fail: %s", result.Message)
	}
}

func TestSmokeGate_NotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	gate := NewSmokeGate()
	result := gate.Execute(context.Background(), GateConfig{
		Type:     "smoke-test",
		Endpoint: server.URL + "/nonexistent",
		Timeout:  5,
	})

	if result.Passed {
		t.Fatal("expected fail for 404, got pass")
	}
}

func TestSmokeGate_Timeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	gate := NewSmokeGate()
	result := gate.Execute(context.Background(), GateConfig{
		Type:     "smoke-test",
		Endpoint: server.URL,
		Timeout:  1,
	})

	if result.Passed {
		t.Fatal("expected fail for timeout, got pass")
	}
}

func TestSmokeGate_DefaultTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	gate := NewSmokeGate()
	result := gate.Execute(context.Background(), GateConfig{
		Type:     "smoke-test",
		Endpoint: server.URL,
		Timeout:  0,
	})

	if !result.Passed {
		t.Fatalf("expected pass with default timeout, got fail: %s", result.Message)
	}
}

func TestDurationGate_Waits(t *testing.T) {
	gate := &DurationGate{}
	start := time.Now()
	result := gate.Execute(context.Background(), GateConfig{
		Type:    "duration",
		Timeout: 1,
	})
	elapsed := time.Since(start)

	if !result.Passed {
		t.Fatalf("expected pass, got fail: %s", result.Message)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("expected at least 900ms wait, got %v", elapsed)
	}
}

func TestDurationGate_DefaultTimeout(t *testing.T) {
	gate := &DurationGate{}
	start := time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	result := gate.Execute(ctx, GateConfig{
		Type:    "duration",
		Timeout: 0,
	})
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("expected duration to be cancelled by context, took %v", elapsed)
	}
	_ = result
}

func TestExecuteGate_Duration(t *testing.T) {
	start := time.Now()
	result := ExecuteGate(context.Background(), GateConfig{
		Type:    "duration",
		Timeout: 1,
	})
	elapsed := time.Since(start)

	if !result.Passed {
		t.Fatalf("expected pass, got fail: %s", result.Message)
	}
	if elapsed < 900*time.Millisecond {
		t.Fatalf("expected at least 900ms wait, got %v", elapsed)
	}
}

func TestExecuteGate_UnknownType(t *testing.T) {
	result := ExecuteGate(context.Background(), GateConfig{
		Type: "nonexistent",
	})

	if result.Passed {
		t.Fatal("expected fail for unknown gate type, got pass")
	}
	if result.Message != "unknown gate type: nonexistent" {
		t.Fatalf("expected 'unknown gate type: nonexistent', got %q", result.Message)
	}
}

func TestExecuteGate_SmokeViaDispatcher(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
