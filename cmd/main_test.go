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

	ports := freePorts(2)
	addr, probeAddr := ports[0], ports[1]

	errCh := make(chan error, 1)
	go func() {
		errCh <- runAPIMode(fakeK8s.URL, tokenFile.Name(), addr, probeAddr)
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
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		panic(fmt.Sprintf("no free port found: %v", err))
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func freePorts(n int) []string {
	addrs := make([]string, n)
	for i := range n {
		addrs[i] = freePort()
	}
	return addrs
}
