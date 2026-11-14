//go:build !unix

package main

import "syscall"

// controlReceiveBuffer is a no-op where the listening socket cannot be sized through
// syscall.SetsockoptInt. Accepted connections are still bounded by setReceiveBuffer.
func controlReceiveBuffer(_ syscall.RawConn, _ int) error {
	return nil
}
