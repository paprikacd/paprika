package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-git/go-git/v5/plumbing/protocol/packp"
	"github.com/go-git/go-git/v5/plumbing/transport"
	gitclient "github.com/go-git/go-git/v5/plumbing/transport/client"
)

// Disk use of the git mirror cache. On omega-ha the repo-server's mirror of
// one ~5 GB repository grew to 117 GB in 15 hours: its shallow fetch could
// not finish inside the client's 5-minute timeout, so every retry was
// cancelled, and each left its partial objects/pack/tmp_pack_* behind.

func packFiles(t *testing.T, mirror, pattern string) []string {
	t.Helper()
	got, err := filepath.Glob(filepath.Join(mirror, "objects", "pack", pattern))
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func resolveWithin(t *testing.T, src *GitSource) (*ResolveResult, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return src.Resolve(ctx)
}

// sessionTransport counts the upload-pack sessions opened on target. With
// cancel set it cancels the request's context as a session opens, the way a
// client gives up mid-fetch; with stall set the session's pack request waits
// for its context to end, a transfer that never progresses.
type sessionTransport struct {
	transport.Transport
	target   string
	cancel   context.CancelFunc
	stall    bool
	sessions int
}

func (s *sessionTransport) NewUploadPackSession(ep *transport.Endpoint, auth transport.AuthMethod) (transport.UploadPackSession, error) {
	sess, err := s.Transport.NewUploadPackSession(ep, auth)
	if err != nil || filepath.Clean(ep.Path) != filepath.Clean(s.target) {
		return sess, err
	}
	s.sessions++
	if s.cancel != nil {
		s.cancel()
	}
	if s.stall {
		return stalledSession{sess}, nil
	}
	return sess, nil
}

type stalledSession struct{ transport.UploadPackSession }

func (stalledSession) UploadPack(ctx context.Context, _ *packp.UploadPackRequest) (*packp.UploadPackResponse, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func installSessionTransport(t *testing.T, s *sessionTransport) {
	t.Helper()
	original := gitclient.Protocols["file"]
	s.Transport = original
	gitclient.InstallProtocol("file", s)
	t.Cleanup(func() { gitclient.InstallProtocol("file", original) })
}

func pushChartChange(t *testing.T, mirror, content string) string {
	t.Helper()
	work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
	writeChartFile(t, work, content)
	runGit(t, work, "commit", "-am", content)
	runGit(t, work, "push", "origin", "main")
	return gitOutput(t, work, "rev-parse", "HEAD")
}

// A client that gives up while its fetch runs does not stop the fetch: the
// mirror holds the new commit, and the next resolve inside FetchTTL opens no
// session at all.
func TestGitSourceResolve_ClientGivingUpMidFetchStillCompletesIt(t *testing.T) {
	src, mirror, _, first := cacheRecoveryFixture(t)
	next := pushChartChange(t, mirror, "synthetic-after-cancel")
	if next == first {
		t.Fatal("the fixture did not move")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	counting := &sessionTransport{target: src.RepoURL, cancel: cancel}
	installSessionTransport(t, counting)
	_, _ = src.Resolve(ctx)
	opened := counting.sessions
	if opened == 0 {
		t.Fatal("the resolve opened no upload-pack session, so nothing was cancelled mid-fetch")
	}
	if got := gitOutput(t, mirror, "rev-parse", "refs/heads/main"); got != next {
		t.Fatalf("mirror main = %s, want %s: the fetch stopped with its client", got, next)
	}
	// The completed fetch stamped the fetch clock, so inside a FetchTTL the
	// next resolve answers from the mirror.
	src.FetchTTL = time.Hour
	counting.cancel = nil
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}
	if counting.sessions != opened {
		t.Fatalf("the next resolve opened %d more sessions, want 0", counting.sessions-opened)
	}
}

// A request that is already done when it gets the repo lock (it queued behind
// a long fetch until its client gave up) starts nothing.
func TestGitSourceResolve_RequestDoneBeforeTheLockStartsNoFetch(t *testing.T) {
	src, mirror, _, _ := cacheRecoveryFixture(t)
	pushChartChange(t, mirror, "synthetic-unread")
	counting := &sessionTransport{target: src.RepoURL}
	installSessionTransport(t, counting)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := src.Resolve(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if counting.sessions != 0 {
		t.Fatalf("a done request opened %d upload-pack sessions", counting.sessions)
	}
}

// The detached fetch is still bounded: a transfer that never progresses ends
// at mirrorFetchBudget, not with the pod.
func TestGitSourceResolve_DetachedFetchEndsAtItsBudget(t *testing.T) {
	src, mirror, _, _ := cacheRecoveryFixture(t)
	pushChartChange(t, mirror, "synthetic-stalled")
	saved := mirrorFetchBudget
	mirrorFetchBudget = 300 * time.Millisecond
	t.Cleanup(func() { mirrorFetchBudget = saved })
	installSessionTransport(t, &sessionTransport{target: src.RepoURL, stall: true})
	done := make(chan error, 1)
	go func() {
		_, err := resolveWithin(t, src)
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("want the budget's deadline, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the stalled fetch outlived its %s budget", mirrorFetchBudget)
	}
}

func TestGitSourceResolve_ShallowMirrorUnchangedBranchFetchesNothing(t *testing.T) {
	src, mirror, _, first := cacheRecoveryFixture(t)
	before := packFiles(t, mirror, "*")
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != first {
		t.Fatalf("revision %s, want %s", got.Revision, first)
	}
	if after := packFiles(t, mirror, "*"); len(after) != len(before) {
		t.Fatalf("pack directory changed: %v -> %v", before, after)
	}
}

func TestGitSourceResolve_FailedFetchLeavesNoPartialPack(t *testing.T) {
	for _, shallow := range []bool{true, false} {
		src, mirror, _, _ := cacheRecoveryFixture(t)
		src.Shallow = shallow
		partial := filepath.Join(mirror, "objects", "pack", "tmp_pack_1034374122")
		if err := os.WriteFile(partial, []byte("half a pack"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(mirror, "sentinel"), []byte("preserve"), 0o600); err != nil {
			t.Fatal(err)
		}
		installFailingCacheTransport(t, src.RepoURL, context.Canceled)
		if _, err := resolveWithin(t, src); !errors.Is(err, context.Canceled) {
			t.Fatalf("shallow=%v: want the cancellation, got %v", shallow, err)
		}
		if _, err := os.Stat(partial); !os.IsNotExist(err) {
			t.Errorf("shallow=%v: the partial pack is still there (%v)", shallow, err)
		}
		if _, err := os.Stat(filepath.Join(mirror, "sentinel")); err != nil {
			t.Errorf("shallow=%v: the mirror was reset on a remote error: %v", shallow, err)
		}
	}
}

func TestGitSourceResolve_FailedFirstCloneLeavesNoMirror(t *testing.T) {
	src, mirror, _, _ := cacheRecoveryFixture(t)
	src.WorkDir = filepath.Join(t.TempDir(), "fresh-cache")
	mirror = filepath.Join(src.WorkDir, "git-mirrors", filepath.Base(mirror))
	installFailingCacheTransport(t, src.RepoURL, context.Canceled)
	if _, err := resolveWithin(t, src); err == nil {
		t.Fatal("want the clone to fail")
	}
	if _, err := os.Stat(mirror); !os.IsNotExist(err) {
		t.Fatalf("a failed first clone left %s behind (%v)", mirror, err)
	}
}
