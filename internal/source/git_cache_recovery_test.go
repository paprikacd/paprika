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
	// graph. Native git-upload-pack, used for file remotes, emits the same
	// remote-side corruption error seen when fetching the local mirror.
	// Rebuild the tiny synthetic mirror with loose objects so corruption is
	// not masked by native Git reusing a still-valid packed copy of the blob.
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
	runGit(t, filepath.Dir(worktree), "init", "--initial-branch=main", worktree)
	runGit(t, worktree, "remote", "add", "origin", mirror)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := src.openExistingWorktree(ctx, worktree)
	if err == nil || !strings.Contains(err.Error(), "fetch worktree:") || !strings.Contains(err.Error(), localUploadPackCorruption) {
		t.Fatalf("native local upload-pack did not reproduce the observed error: %v", err)
	}
	t.Log("native local mirror error reproduced:", err)
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

type failingCacheTransport struct {
	transport.Transport
	target   string
	err      error
	attempts int
}

func (f *failingCacheTransport) NewUploadPackSession(ep *transport.Endpoint, auth transport.AuthMethod) (transport.UploadPackSession, error) {
	if filepath.Clean(ep.Path) == filepath.Clean(f.target) {
		f.attempts++
		if f.attempts > 2 {
			return nil, errors.New("test stops an unbounded repair loop")
		}
		return nil, f.err
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

func TestGitSourceResolve_LocalCorruptionRetryIsBounded(t *testing.T) {
	src, mirror, _, _ := cacheRecoveryFixture(t)
	failing := installFailingCacheTransport(t, mirror, errors.New(localUploadPackCorruption))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := src.Resolve(ctx)
	if err == nil || !strings.Contains(err.Error(), localUploadPackCorruption) {
		t.Fatalf("expected persistent local corruption: %v", err)
	}
	if failing.attempts != 2 {
		t.Fatalf("want initial local fetch plus one repair, got %d attempts", failing.attempts)
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
		{"fetch worktree: unexpected error: " + localUploadPackCorruption, true},
		{"fetch worktree from mirror: unexpected error: " + localUploadPackCorruption, true},
		{"fetch repo https://example.test/repo: " + localUploadPackCorruption, false},
		{"clone remote: " + localUploadPackCorruption, false},
		{"fetch worktree: authentication required", false},
		{"fetch worktree: context deadline exceeded", false},
		{"fetch worktree: context canceled", false},
	} {
		t.Run(tc.message, func(t *testing.T) {
			if got := isRecoverableGitCacheError(errors.New(tc.message)); got != tc.want {
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
	first, mirror, _, revision := cacheRecoveryFixture(t)
	second := *first
	original := gitclient.Protocols["file"]
	blocked := &serializedCacheTransport{Transport: original, target: mirror, entered: make(chan struct{}, 2), release: make(chan struct{})}
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
