//go:build linux

package source

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// prSetChildSubreaper makes orphaned descendants reparent to this process, as
// they do to /manager when it is PID 1 in a container.
const prSetChildSubreaper = 36

// A fetch killed at its timeout leaves no zombie: git's children, orphaned by
// the kill, are reparented to the process (PID 1 in a container, a subreaper
// here) and reaped by it.
func TestCLIResolve_KilledFetchLeavesNoZombies(t *testing.T) {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		t.Skipf("cannot become a subreaper: %v", errno)
	}
	t.Cleanup(func() { _, _, _ = syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 0, 0) })
	srv, _, _ := chartFixture(t)
	srv.hold = make(chan struct{})
	t.Cleanup(func() { close(srv.hold) })
	withGitSettings(t, func(s *gitSettings) { s.fetchTimeout = 2 * time.Second })
	var mu sync.Mutex
	var fetch int
	gitProcessStarted = func(args []string, pid int) {
		if gitOp(args) == "fetch" {
			mu.Lock()
			fetch = pid
			mu.Unlock()
		}
	}
	t.Cleanup(func() { gitProcessStarted = nil })

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	_, err := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir()).Resolve(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("resolve = %v, want the fetch's deadline", err)
	}
	mu.Lock()
	pgid := fetch
	mu.Unlock()
	deadline := time.Now().Add(reapWindow + 5*time.Second)
	for {
		left := groupMembers(t, pgid)
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("processes of the killed fetch's group %d remain (pid:state): %v", pgid, left)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// groupMembers lists, as pid:state, the processes whose process group is
// pgid, zombies included.
func groupMembers(t *testing.T, pgid int) []string {
	t.Helper()
	stats, err := filepath.Glob("/proc/[0-9]*/stat")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, p := range stats {
		raw, err := os.ReadFile(p) // #nosec G304 -- /proc
		if err != nil {
			continue // exited
		}
		// pid (comm) state ppid pgrp ...; comm may hold spaces.
		fields := strings.Fields(string(raw[bytes.LastIndexByte(raw, ')')+1:]))
		if len(fields) < 3 {
			continue
		}
		if g, _ := strconv.Atoi(fields[2]); g == pgid {
			out = append(out, filepath.Base(filepath.Dir(p))+":"+fields[0])
		}
	}
	return out
}
