//go:build unix

package main

import (
	"syscall"
	"testing"

	"github.com/stretchr/testify/require"
)

// receiveBufferOf reads back the receive buffer size of the socket behind raw.
func receiveBufferOf(t *testing.T, raw syscall.RawConn) int {
	t.Helper()
	var size int
	var sockErr error
	require.NoError(t, raw.Control(func(fd uintptr) {
		size, sockErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	}))
	require.NoError(t, sockErr)
	return size
}
