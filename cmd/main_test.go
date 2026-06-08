package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestAPIModeStartsWithoutError(t *testing.T) {
	fakeK8s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer fakeK8s.Close()

	tokenFile, err := os.CreateTemp(t.TempDir(), "token")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenFile.Name(), []byte("fake-token"), 0600); err != nil {
		t.Fatal(err)
	}
	tokenFile.Close()

	addr := freePort()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(fakeK8s.URL, tokenFile.Name(), addr)
	}()

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("runAPIMode returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("healthz request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz returned status %d", resp.StatusCode)
	}
}

func freePort() string {
	for port := 10000; port < 11000; port++ {
		addr := fmt.Sprintf("localhost:%d", port)
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			ln.Close()
			return addr
		}
	}
	panic("no free port found")
}
