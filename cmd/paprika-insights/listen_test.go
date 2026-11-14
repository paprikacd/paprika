package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"strconv"
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
	requireBoundedReceiveBuffer(t, raw)
}

// requireBoundedReceiveBuffer checks that conn's receive buffer is at the bound, not at
// the autotuned size a long-lived connection would otherwise grow to.
func requireBoundedReceiveBuffer(t *testing.T, conn *net.TCPConn) {
	t.Helper()
	raw, err := conn.SyscallConn()
	require.NoError(t, err)
	// Linux reports twice the value it was set to, to allow for its bookkeeping. Other
	// systems report the value set. Either way the buffer is far below an autotuned one.
	require.LessOrEqual(t, receiveBufferOf(t, raw), 2*insightsReceiveBuffer, "accepted connection receive buffer")
}

// The production startup path, serve, must hand its accepted connections the bound. A
// server that listens without listenInsights accepts connections with the autotuned
// buffer, and this test fails on that.
func TestServeBoundsAcceptedReceiveBuffers(t *testing.T) {
	probe, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := probe.Addr().String()
	require.NoError(t, probe.Close())

	accepted := make(chan *net.TCPConn, 1)
	server := &http.Server{Handler: http.NotFoundHandler(), ReadHeaderTimeout: 5 * time.Second, ConnState: func(conn net.Conn, state http.ConnState) {
		if tcp, ok := conn.(*net.TCPConn); ok && state == http.StateNew {
			select {
			case accepted <- tcp:
			default:
			}
		}
	}}
	ctx, cancel := context.WithCancel(t.Context())
	served := make(chan error, 1)
	go func() { served <- serve(ctx, server, addr) }()
	t.Cleanup(func() {
		cancel()
		require.NoError(t, <-served)
	})

	var client net.Conn
	require.Eventually(t, func() bool {
		conn, dialErr := (&net.Dialer{}).DialContext(t.Context(), "tcp", addr)
		if dialErr == nil {
			client = conn
		}
		return dialErr == nil
	}, 5*time.Second, 10*time.Millisecond, "dial the production listener")
	// Closing the client first lets Shutdown finish without waiting for an idle connection.
	t.Cleanup(func() { _ = client.Close() })

	select {
	case conn := <-accepted:
		requireBoundedReceiveBuffer(t, conn)
	case <-time.After(5 * time.Second):
		t.Fatal("the production listener accepted no connection")
	}
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
