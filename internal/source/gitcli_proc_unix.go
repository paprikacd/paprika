//go:build unix

package source

import (
	"errors"
	"os/exec"
	"syscall"
)

// isolateProcessGroup starts git in a process group of its own and makes
// cancellation kill the whole group: git fetch runs git-remote-https and
// git-index-pack as children, which killing git alone would leave running.
func isolateProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return killProcessGroup(cmd.Process.Pid)
	}
}

// killProcessGroup sends SIGKILL to every process in the group pgid leads.
// A group that is already gone is not an error.
func killProcessGroup(pgid int) error {
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err //nolint:wrapcheck // exec.Cmd reports it as the cancel error
	}
	return nil
}
