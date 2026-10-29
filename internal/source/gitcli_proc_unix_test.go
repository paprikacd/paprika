//go:build unix

package source

import (
	"context"
	"errors"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A fetch that outlives its timeout is killed with every process git started
// (git-remote-http, index-pack): nothing is left fetching.
func TestCLIResolve_FetchTimeoutKillsGitAndItsChildren(t *testing.T) {
	srv, _, _ := chartFixture(t)
	srv.hold = make(chan struct{})
	t.Cleanup(func() { close(srv.hold) })
	withGitSettings(t, func(s *gitSettings) { s.fetchTimeout = 2 * time.Second })
	var mu sync.Mutex
	var fetchPIDs []int
	gitProcessStarted = func(args []string, pid int) {
		if gitOp(args) == "fetch" {
			mu.Lock()
			fetchPIDs = append(fetchPIDs, pid)
			mu.Unlock()
		}
	}
	t.Cleanup(func() { gitProcessStarted = nil })

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	_, err := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir()).Resolve(ctx)

	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("resolve = %v, want the fetch's deadline", err)
	}
	if elapsed := time.Since(start); elapsed > 20*time.Second {
		t.Fatalf("resolve took %s to give up on a 2s fetch timeout", elapsed)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(fetchPIDs) != 1 {
		t.Fatalf("started %d fetches, want 1", len(fetchPIDs))
	}
	assertProcessGroupGone(t, fetchPIDs[0])
}

// assertProcessGroupGone waits briefly for the group pgid leads to be reaped.
func assertProcessGroupGone(t *testing.T, pgid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := syscall.Kill(-pgid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("process group %d still has processes: %v", pgid, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
