package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-git/go-git/v5/plumbing/transport"
	gitclient "github.com/go-git/go-git/v5/plumbing/transport/client"
)

const localUploadPackCorruption = "aborting due to possible repository corruption on the remote side."

func cacheRecoveryFixture(t *testing.T) (*GitSource, string, string, string) {
	t.Helper()
	root := t.TempDir()
	origin, work := filepath.Join(root, "origin.git"), filepath.Join(root, "work")
	runGit(t, root, "init", "--bare", "--initial-branch=main", origin)
	runGit(t, root, "init", "--initial-branch=main", work)
	runGit(t, work, "config", "user.email", "synthetic@example.test")
	runGit(t, work, "config", "user.name", "Synthetic Test")
	runGit(t, work, "remote", "add", "origin", origin)
	writeChartFile(t, work, "synthetic-recovery")
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "synthetic chart")
	runGit(t, work, "push", "origin", "main")
	src := &GitSource{RepoURL: origin, Revision: "main", Path: "chart", WorkDir: filepath.Join(root, "cache"), Shallow: true}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	first, err := src.Resolve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	key := RepoCacheKey(origin, "")
	return src, filepath.Join(src.WorkDir, "git-mirrors", key), filepath.Join(src.WorkDir, "git-clones", key), first.Revision
}

func TestGitSourceResolve_RepairsLocalUploadPackCorruption(t *testing.T) {
	src, mirror, worktree, revision := cacheRecoveryFixture(t)
	src.Revision = revision // Release rendering must retain its exact pinned commit.
	// Corrupt one loose blob while retaining the mirror's valid commit/ref
	// graph — the checkout's object read then trips on the damage. Rebuild
	// the tiny synthetic mirror with loose objects so corruption is not
	// masked by a still-valid packed copy of the blob.
	if err := os.RemoveAll(mirror); err != nil {
		t.Fatal(err)
	}
	runGit(t, filepath.Dir(mirror), "clone", "--bare", "--no-hardlinks", src.RepoURL, mirror)
	blob := gitOutput(t, mirror, "rev-parse", "HEAD:chart/values.yaml")
	object := filepath.Join(mirror, "objects", blob[:2], blob[2:])
	if _, err := os.Stat(object); err != nil {
		t.Fatalf("fixture needs a loose blob: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(object), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(object, []byte("corrupt synthetic blob"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(worktree + ".rev"); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	sibling := filepath.Join(src.WorkDir, "git-mirrors", "sibling-cache", "sentinel")
	if mkdirErr := os.MkdirAll(filepath.Dir(sibling), 0o700); mkdirErr != nil {
		t.Fatal(mkdirErr)
	}
	if writeErr := os.WriteFile(sibling, []byte("unchanged sibling"), 0o600); writeErr != nil {
		t.Fatal(writeErr)
	}
	got, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("expected one protected repair of local corruption: %v", err)
	}
	if got.Revision != revision {
		t.Fatalf("revision changed: %s != %s", got.Revision, revision)
	}
	content, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
	if err != nil || string(content) != "version: synthetic-recovery\n" {
		t.Fatalf("recovered content mismatch: %q (%v)", content, err)
	}
	//nolint:gosec // Test reads its own sentinel within a t.TempDir fixture.
	content, err = os.ReadFile(sibling)
	if err != nil || string(content) != "unchanged sibling" {
		t.Fatalf("sibling cache was modified: %q (%v)", content, err)
	}
}

func TestGitSourceResolve_PinnedCommitBelowShallowBoundary(t *testing.T) {
	src, mirror, worktree, pinned := cacheRecoveryFixture(t)

	// Advance main so the pinned commit sits below the next shallow tip.
	work := filepath.Join(t.TempDir(), "work")
	runGit(t, filepath.Dir(work), "clone", src.RepoURL, work)
	runGit(t, work, "config", "user.email", "synthetic@example.test")
	runGit(t, work, "config", "user.name", "Synthetic Test")
	writeChartFile(t, work, "advanced")
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "advance main")
	runGit(t, work, "push", "origin", "main")

	// Pod restart: the emptyDir cache is wiped, then a branch resolve
	// rebuilds the mirror shallow at the new tip.
	if err := resetGitCache(mirror, worktree); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	src.Revision = "main"
	if _, err := src.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mirror, "shallow")); err != nil {
		t.Fatalf("fixture requires a shallow mirror: %v", err)
	}

	// Rendering the previously pinned release commit must recover: either
	// an exact-commit fetch or a full cache rebuild, never a hard failure.
	src.Revision = pinned
	got, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("pinned commit below shallow boundary did not recover: %v", err)
	}
	if got.Revision != pinned {
		t.Fatalf("revision changed: %s != %s", got.Revision, pinned)
	}
	content, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
	if err != nil || string(content) != "version: synthetic-recovery\n" {
		t.Fatalf("pinned content mismatch: %q (%v)", content, err)
	}
}

func TestGitSourceResolve_PinnedCommitGoneFromRemote(t *testing.T) {
	src, mirror, worktree, _ := cacheRecoveryFixture(t)
	if err := resetGitCache(mirror, worktree); err != nil {
		t.Fatal(err)
	}
	src.Revision = "0123456789abcdef0123456789abcdef01234567"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := src.Resolve(ctx); err == nil {
		t.Fatal("expected unresolvable pinned commit to fail")
	} else if !strings.Contains(err.Error(), "not found as branch, tag, or commit") {
		t.Fatalf("unexpected error: %v", err)
	}
}

type failingCacheTransport struct {
	transport.Transport
	target   string
	err      error
	attempts int
}

func (f *failingCacheTransport) NewUploadPackSession(ep *transport.Endpoint, auth transport.AuthMethod) (transport.UploadPackSession, error) {
	if filepath.Clean(ep.Path) == filepath.Clean(f.target) {
		f.attempts++
		if f.err != nil {
			if f.attempts > 2 {
				return nil, errors.New("test stops an unbounded repair loop")
			}
			return nil, f.err
		}
	}
	return f.Transport.NewUploadPackSession(ep, auth)
}

func installFailingCacheTransport(t *testing.T, target string, err error) *failingCacheTransport {
	t.Helper()
	original := gitclient.Protocols["file"]
	failing := &failingCacheTransport{Transport: original, target: target, err: err}
	gitclient.InstallProtocol("file", failing)
	t.Cleanup(func() { gitclient.InstallProtocol("file", original) })
	return failing
}

func TestGitSourceResolve_LocalCorruptionRepairRefetchesOnce(t *testing.T) {
	src, mirror, worktree, _ := cacheRecoveryFixture(t)
	// Corrupt the checkout's materialized content by damaging the mirror
	// objects — the protected repair path must rebuild the mirror with a
	// single upstream refetch, not loop.
	if err := os.RemoveAll(mirror); err != nil {
		t.Fatal(err)
	}
	runGit(t, filepath.Dir(mirror), "clone", "--bare", "--no-hardlinks", src.RepoURL, mirror)
	blob := gitOutput(t, mirror, "rev-parse", "HEAD:chart/values.yaml")
	object := filepath.Join(mirror, "objects", blob[:2], blob[2:])
	if err := os.MkdirAll(filepath.Dir(object), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(object, []byte("corrupt synthetic blob"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(worktree); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(worktree + ".rev"); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	counting := installFailingCacheTransport(t, src.RepoURL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := src.Resolve(ctx); err != nil {
		t.Fatalf("expected one protected repair: %v", err)
	}
	// One protected rebuild — the file transport can cost a second session
	// when the "+HEAD:" refspec isn't served (GitHub/HTTP serve it).
	if counting.attempts < 1 || counting.attempts > 2 {
		t.Fatalf("want a bounded single rebuild fetch, got %d attempts", counting.attempts)
	}
}

func TestGitSourceResolve_RemoteAuthAndTimeoutErrorsDoNotReset(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"remote corruption", errors.New(localUploadPackCorruption)},
		{"authentication", transport.ErrAuthenticationRequired},
		{"deadline", context.DeadlineExceeded},
		{"cancellation", context.Canceled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, worktree, _ := cacheRecoveryFixture(t)
			for _, dir := range []string{mirror, worktree} {
				if err := os.WriteFile(filepath.Join(dir, "sentinel"), []byte("preserve"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			failing := installFailingCacheTransport(t, src.RepoURL, tc.err)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, err := src.Resolve(ctx)
			if err == nil {
				t.Fatal("expected remote failure")
			}
			if failing.attempts != 1 {
				t.Fatalf("remote error retried %d times", failing.attempts)
			}
			for _, dir := range []string{mirror, worktree} {
				//nolint:gosec // Test reads its own sentinel within a t.TempDir fixture.
				got, readErr := os.ReadFile(filepath.Join(dir, "sentinel"))
				if readErr != nil || string(got) != "preserve" {
					t.Fatalf("cache reset on remote error: %v", readErr)
				}
			}
		})
	}
}

func TestRecoverableGitCacheError_LocalRemoteDistinction(t *testing.T) {
	for _, tc := range []struct {
		message string
		want    bool
	}{
		{"checkout tree: read blob a.txt: zlib reading error: zlib: invalid header", true},
		{"checkout tree: read commit: object not found", true},
		{"fetch worktree: unexpected error: " + localUploadPackCorruption, true},
		{"fetch worktree from mirror: unexpected error: " + localUploadPackCorruption, true},
		{"fetch repo https://example.test/repo: " + localUploadPackCorruption, false},
		{"checkout tree: read blob: " + localUploadPackCorruption, true},
		{"clone remote: " + localUploadPackCorruption, false},
		{"checkout tree: read blob: authentication required", false},
		{"checkout tree: read blob: context deadline exceeded", false},
		{"checkout tree: read blob: context canceled", false},
	} {
		t.Run(tc.message, func(t *testing.T) {
			src := &GitSource{RepoURL: "https://example.test/repo"}
			if got := src.isRecoverableGitCacheError(errors.New(tc.message)); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

type serializedCacheTransport struct {
	transport.Transport
	target  string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *serializedCacheTransport) NewUploadPackSession(ep *transport.Endpoint, auth transport.AuthMethod) (transport.UploadPackSession, error) {
	if filepath.Clean(ep.Path) == filepath.Clean(s.target) {
		s.entered <- struct{}{}
		s.once.Do(func() { <-s.release })
	}
	return s.Transport.NewUploadPackSession(ep, auth)
}

func TestGitSourceResolve_SerializesSeparateInstancesForSameCache(t *testing.T) {
	first, _, _, revision := cacheRecoveryFixture(t)
	second := *first
	original := gitclient.Protocols["file"]
	// Block on the upstream fetch — every resolve updates the mirror, so a
	// concurrent instance can only enter this transport when it bypasses
	// the per-repo key lock.
	blocked := &serializedCacheTransport{Transport: original, target: first.RepoURL, entered: make(chan struct{}, 2), release: make(chan struct{})}
	gitclient.InstallProtocol("file", blocked)
	t.Cleanup(func() { gitclient.InstallProtocol("file", original) })
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(blocked.release) }) }
	defer unblock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	resolve := func(src *GitSource) {
		got, err := src.Resolve(ctx)
		if err == nil && got.Revision != revision {
			err = errors.New("revision changed")
		}
		results <- err
	}
	go resolve(first)
	select {
	case <-blocked.entered:
	case <-ctx.Done():
		t.Fatal("first instance did not reach local fetch")
	}
	go resolve(&second)
	select {
	case <-blocked.entered:
		t.Error("second instance entered cache fetch while first still held the key lock")
	case <-time.After(100 * time.Millisecond):
	}
	unblock()
	for i := 0; i < 2; i++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("instances did not finish after unlock")
		}
	}
}
