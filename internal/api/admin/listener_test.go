package admin

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAdminListenerBindsSynchronouslyOnlyToFixedLoopbackAddress(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()

	listener, err := NewListener(ctx, statusHandler(http.StatusNoContent))
	require.NoError(t, err)
	t.Cleanup(func() {
		require.NoError(t, listener.Close())
	})
	assert.Equal(t, "127.0.0.1:3001", listener.Addr().String())

	_, err = NewListener(ctx, statusHandler(http.StatusNoContent))
	require.Error(t, err)
	assert.True(t, errors.Is(err, syscall.EADDRINUSE) || stringsContainAddressInUse(err), err)
}

func TestAdminListenerClosesOnContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	listener, err := NewListener(ctx, statusHandler(http.StatusNoContent))
	require.NoError(t, err)

	served := make(chan error, 1)
	go func() {
		served <- listener.Serve()
	}()
	dialer := &net.Dialer{Timeout: 20 * time.Millisecond}
	require.Eventually(t, func() bool {
		connection, dialErr := dialer.DialContext(t.Context(), "tcp4", AdminListenerAddress)
		if dialErr != nil {
			return false
		}
		require.NoError(t, connection.Close())
		return true
	}, time.Second, 10*time.Millisecond)

	cancel()
	select {
	case serveErr := <-served:
		require.NoError(t, serveErr)
	case <-time.After(time.Second):
		t.Fatal("admin listener did not stop after context cancellation")
	}

	connection, dialErr := dialer.DialContext(t.Context(), "tcp4", AdminListenerAddress)
	if dialErr == nil {
		_ = connection.Close()
		t.Fatal("admin listener still accepts connections after cancellation")
	}
}

func TestAdminListenerContextCancellationGracefullyCompletesInFlightRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	var releaseOnce sync.Once
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
		close(finished)
	})
	listener, err := NewListener(ctx, handler)
	require.NoError(t, err)
	t.Cleanup(func() {
		releaseOnce.Do(func() {
			close(release)
		})
		cancel()
		_ = listener.Close()
	})

	served := make(chan error, 1)
	go func() {
		served <- listener.Serve()
	}()
	type requestResult struct {
		status int
		err    error
	}
	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"http://127.0.0.1:3001/in-flight",
		http.NoBody,
	)
	require.NoError(t, err)
	requested := make(chan requestResult, 1)
	go func() {
		// #nosec G704 -- the request targets the fixed loopback-only admin listener.
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			requested <- requestResult{err: requestErr}
			return
		}
		defer func() {
			_ = response.Body.Close()
		}()
		requested <- requestResult{status: response.StatusCode}
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("in-flight admin request did not start")
	}
	cancel()
	select {
	case result := <-requested:
		t.Fatalf("in-flight request completed before handler release: %+v", result)
	case <-time.After(50 * time.Millisecond):
	}
	select {
	case serveErr := <-served:
		t.Fatalf("admin Serve returned before handler release: %v", serveErr)
	case <-time.After(50 * time.Millisecond):
	}

	releaseOnce.Do(func() {
		close(release)
	})
	select {
	case result := <-requested:
		require.NoError(t, result.err)
		assert.Equal(t, http.StatusNoContent, result.status)
	case <-time.After(time.Second):
		t.Fatal("in-flight request did not complete after release")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("in-flight handler did not finish")
	}
	select {
	case serveErr := <-served:
		require.NoError(t, serveErr)
	case <-time.After(time.Second):
		t.Fatal("admin listener did not join after graceful shutdown")
	}
	require.NoError(t, listener.Close())
}

func TestAdminListenerForcesCloseAfterGracefulShutdownDeadline(t *testing.T) {
	const shutdownTimeout = 25 * time.Millisecond

	ctx, cancel := context.WithCancel(t.Context())
	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	var releaseOnce sync.Once
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
		close(finished)
	})
	listener, err := newListener(ctx, handler, shutdownTimeout)
	require.NoError(t, err)
	t.Cleanup(func() {
		releaseOnce.Do(func() {
			close(release)
		})
		cancel()
		_ = listener.Close()
	})

	served := make(chan error, 1)
	go func() {
		served <- listener.Serve()
	}()
	request, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"http://127.0.0.1:3001/blocked",
		http.NoBody,
	)
	require.NoError(t, err)
	requested := make(chan error, 1)
	go func() {
		// #nosec G704 -- the request targets the fixed loopback-only admin listener.
		response, requestErr := http.DefaultClient.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		requested <- requestErr
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("blocked admin request did not start")
	}

	shutdownStarted := time.Now()
	cancel()
	var serveErr error
	select {
	case serveErr = <-served:
	case <-time.After(time.Second):
		t.Fatal("admin listener did not force-close after shutdown deadline")
	}
	assert.ErrorIs(t, serveErr, context.DeadlineExceeded)
	assert.GreaterOrEqual(t, time.Since(shutdownStarted), shutdownTimeout)
	assert.ErrorIs(t, listener.Close(), context.DeadlineExceeded)
	select {
	case requestErr := <-requested:
		require.Error(t, requestErr)
	case <-time.After(time.Second):
		t.Fatal("force-closed admin request did not return")
	}

	releaseOnce.Do(func() {
		close(release)
	})
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("blocked handler did not finish after cleanup release")
	}
}

func stringsContainAddressInUse(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "address already in use") ||
		strings.Contains(err.Error(), "only one usage of each socket address"))
}
