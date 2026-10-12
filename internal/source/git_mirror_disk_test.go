package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
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

// A request cancelled before its fetch finishes does not cancel the fetch:
// the next resolve then finds the mirror filled instead of starting over.
func TestGitSourceResolve_CancelledRequestStillCompletesTheFetch(t *testing.T) {
	src, mirror, _, first := cacheRecoveryFixture(t)
	work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
	writeChartFile(t, work, "synthetic-after-cancel")
	runGit(t, work, "commit", "-am", "synthetic after cancel")
	runGit(t, work, "push", "origin", "main")
	next := gitOutput(t, work, "rev-parse", "HEAD")
	if next == first {
		t.Fatal("the fixture did not move")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _ = src.Resolve(ctx)
	if got := gitOutput(t, mirror, "rev-parse", "refs/heads/main"); got != next {
		t.Fatalf("mirror main = %s, want %s: the fetch stopped with its request", got, next)
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
