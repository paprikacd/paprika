//go:build !unix

package main

import (
	"syscall"
	"testing"
)

// receiveBufferOf cannot read the socket option back on this system, so the bound
// tests that need it are skipped here. The bound itself is still set in production.
func receiveBufferOf(t *testing.T, _ syscall.RawConn) int {
	t.Helper()
	t.Skip("receive buffer readback is only implemented for unix sockets")
	return 0
}
