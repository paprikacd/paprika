package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestAPIModeStartsWithoutError(t *testing.T) {
	fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer fakeK8s.Close()

	tokenFile, err := os.CreateTemp(t.TempDir(), "token")
	if err != nil {
		t.Fatal(err)
	}
	if wErr := os.WriteFile(tokenFile.Name(), []byte("fake-token"), 0o600); wErr != nil {
		t.Fatal(wErr)
	}
	_ = tokenFile.Close()

	ports := freePorts(2)
	addr, probeAddr := ports[0], ports[1]

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(fakeK8s.URL, tokenFile.Name(), addr, probeAddr,
			false, "", "", "", "", "", "", false)
	}()

	select {
	case e := <-errCh:
		if e != nil {
			t.Fatalf("runAPIMode returned error: %v", e)
		}
	case <-time.After(3 * time.Second):
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/healthz", http.NoBody)
	if err != nil {
		t.Fatalf("build healthz request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("healthz request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz returned status %d", resp.StatusCode)
	}
}

func freePort() string {
	lc := net.ListenConfig{}
	ctx := context.Background()
	ln, err := lc.Listen(ctx, "tcp", "localhost:0")
	if err != nil {
		panic(fmt.Sprintf("no free port found: %v", err))
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func freePorts(n int) []string {
	addrs := make([]string, n)
	for i := range n {
		addrs[i] = freePort()
	}
	return addrs
}

func TestRepoServerHealthEndpoint(t *testing.T) {
	addr, probeAddr := freePort(), freePort()
	go func() {
		_ = runRepoServerMode(addr, probeAddr)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}
}

func waitForHealthz(ctx context.Context, probeAddr string) error {
	url := "http://" + probeAddr + "/healthz"
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	var lastErr error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("healthz returned status %d", resp.StatusCode)
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %w", ctx.Err(), lastErr)
		case <-ticker.C:
		}
	}
}
