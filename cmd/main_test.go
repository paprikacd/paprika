package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/benebsworth/paprika/internal/cache"
)

func TestAPIModeStartsWithoutError(t *testing.T) {
	t.Parallel()

	fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte(`{}`)); err != nil {
			t.Errorf("Failed to write fake Kubernetes response: %v", err)
		}
	}))
	defer fakeK8s.Close()

	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("fake-token"), 0o600); err != nil {
		t.Fatal(err)
	}

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(ctx, &cliConfig{
			mode:         "api",
			k8sAPIServer: fakeK8s.URL,
			k8sTokenFile: tokenFile,
			uiAddr:       ":0",
			probeAddr:    ":0",
		}, newScheme(), logr.Discard(), probeAddrCh)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runAPIMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for API mode to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runAPIMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runAPIMode to exit")
	}
}

func TestRepoServerHealthEndpoint(t *testing.T) {
	t.Parallel()

	probeAddrCh := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	k8sClient := fake.NewClientBuilder().WithScheme(newScheme()).Build()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runRepoServerMode(ctx, ":0", ":0", t.TempDir(), ":0", newScheme(), logr.Discard(), cache.Config{Backend: "memory"}, probeAddrCh, k8sClient)
	}()

	var probeAddr string
	select {
	case probeAddr = <-probeAddrCh:
	case err := <-errCh:
		t.Fatalf("runRepoServerMode exited before binding: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for repo server to bind")
	}

	if err := waitForHealthz(ctx, probeAddr); err != nil {
		t.Fatalf("healthz probe failed: %v", err)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Fatalf("runRepoServerMode returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for runRepoServerMode to exit")
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
