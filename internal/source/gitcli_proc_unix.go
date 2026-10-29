//go:build unix

package source

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
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

// reapWindow bounds how long reapProcessGroup waits for a killed group.
const reapWindow = 10 * time.Second

// reapProcessGroup waits for the processes of the killed group pgid that were
// reparented to this process. Killing git orphans its children
// (git-remote-https, index-pack), and the kernel hands an orphan to the
// nearest subreaper or to PID 1. In a container PID 1 is /manager, which has
// no init to reap them, so every timed-out fetch would leave zombies behind.
// Elsewhere nothing of the group is this process's child and wait4 reports
// ECHILD at once. Called after exec.Cmd.Wait has reaped git itself, it can
// take no child another Wait owns: every git this package starts leads a
// group of its own.
func reapProcessGroup(pgid int) {
	deadline := time.Now().Add(reapWindow)
	for time.Now().Before(deadline) {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-pgid, &status, syscall.WNOHANG, nil)
		switch {
		case errors.Is(err, syscall.EINTR):
		case err != nil:
			return // ECHILD: nothing of the group is left to reap
		case pid == 0:
			time.Sleep(20 * time.Millisecond) // killed, not yet exited
		}
	}
}
