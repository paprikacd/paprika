//go:build unix

package main

import (
	"fmt"
	"syscall"
)

// controlReceiveBuffer sets the receive buffer of the listening socket behind raw. Linux
// gives accepted sockets their listener's buffer size, so this bounds connections that
// are still waiting in the accept queue too.
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
