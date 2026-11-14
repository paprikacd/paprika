package main

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// An accepted connection's receive buffer stays at the bound, not at the autotuned
// size a long-lived connection would otherwise grow to.
func TestListenInsightsBoundsAcceptedReceiveBuffers(t *testing.T) {
	ln, err := listenInsights(t.Context(), "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })

	client, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", ln.Addr().String())
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })
	accepted, err := ln.Accept()
	require.NoError(t, err)
	t.Cleanup(func() { _ = accepted.Close() })

	raw, ok := accepted.(*net.TCPConn)
	require.True(t, ok)
	file, err := raw.File()
	require.NoError(t, err)
	t.Cleanup(func() { _ = file.Close() })
	size, err := syscall.GetsockoptInt(int(file.Fd()), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	require.NoError(t, err)
	// Linux reports twice the value it was set to, to allow for its bookkeeping. Other
	// systems report the value set. Either way the buffer is far below an autotuned one.
	require.LessOrEqual(t, size, 2*insightsReceiveBuffer, "accepted connection receive buffer")
}

// A request body larger than the bound still arrives whole. The bound makes the sender
// wait for window updates; it must not cut a dashboard upload short.
func TestListenInsightsDeliversLargeBodies(t *testing.T) {
	ln, err := listenInsights(t.Context(), "127.0.0.1:0")
	require.NoError(t, err)
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			http.Error(w, readErr.Error(), http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(strconv.Itoa(len(body))))
	})}
	served := make(chan error, 1)
	go func() { served <- server.Serve(ln) }()
	t.Cleanup(func() {
		_ = server.Close()
		<-served
	})

	payload := bytes.Repeat([]byte("x"), 1<<20)
	client := &http.Client{Timeout: 10 * time.Second}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, "http://"+ln.Addr().String()+"/", bytes.NewReader(payload))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(request)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, strconv.Itoa(len(payload)), string(got))
}
