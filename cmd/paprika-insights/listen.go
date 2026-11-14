package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"syscall"
)

// insightsReceiveBuffer is the kernel receive buffer, in bytes, that each accepted
// connection gets. The Insights budget bounds the body bytes a handler holds, but a
// connection's socket buffer is kernel memory that a sender's flood grows. The kernel
// autotunes each buffer up to several MiB, and a refused request's connection then
// lingers for Go's half-second close delay with its buffer full. At 8 KiB a connection
// holds about 16 KiB (Linux doubles the value), and a proxy in the same cluster still
// delivers a dashboard body in a few dozen round trips at sub-millisecond latency. The
// README has the flood measurements.
const insightsReceiveBuffer = 8 << 10

// listenInsights listens on addr and bounds the receive buffer of every connection it
// accepts. The bound is set on the listening socket, so a system that gives accepted
// sockets their listener's buffer size (Linux) bounds connections still waiting in the
// accept queue, and on each accepted socket, which covers the systems that do not.
func listenInsights(ctx context.Context, addr string) (net.Listener, error) {
	config := net.ListenConfig{Control: func(_, _ string, c syscall.RawConn) error {
		return controlReceiveBuffer(c, insightsReceiveBuffer)
	}}
	ln, err := config.Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	return boundedReceiveListener{Listener: ln}, nil
}

// boundedReceiveListener sets insightsReceiveBuffer on each connection it accepts.
type boundedReceiveListener struct {
	net.Listener
}

// Accept returns the next connection with its buffer bound. A connection whose bound
// cannot be set is closed and skipped: an error from Accept would stop the server.
func (l boundedReceiveListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err //nolint:wrapcheck // net.Listener's own error, which http.Server expects unwrapped
		}
		tcp, ok := conn.(*net.TCPConn)
		if !ok {
			return conn, nil
		}
		if err := setReceiveBuffer(tcp, insightsReceiveBuffer); err != nil {
			slog.Warn("drop connection without a receive buffer bound", "error", err)
			if closeErr := conn.Close(); closeErr != nil {
				slog.Debug("close connection without a receive buffer bound", "error", closeErr)
			}
			continue
		}
		return conn, nil
	}
}

func setReceiveBuffer(conn *net.TCPConn, size int) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return fmt.Errorf("reach connection socket: %w", err)
	}
	return controlReceiveBuffer(raw, size)
}

// controlReceiveBuffer sets the receive buffer of the socket behind raw to size.
func controlReceiveBuffer(raw syscall.RawConn, size int) error {
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		sockErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, size)
	}); err != nil {
		return fmt.Errorf("control socket: %w", err)
	}
	if sockErr != nil {
		return fmt.Errorf("set receive buffer: %w", sockErr)
	}
	return nil
}
