package source

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// packBytes is the total size of a mirror's packfiles.
func packBytes(t *testing.T, mirror string) int64 {
	t.Helper()
	var total int64
	for _, p := range packFiles(t, mirror, "*.pack") {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		total += info.Size()
	}
	return total
}

// A push to a branch a shallow mirror follows adds only what changed. With
// the shallow depth on every fetch, go-git's request carries no thin-pack
// capability, so the server re-sent the whole tree on each push: on omega-ha
// a 4.8 GB repository grew its mirror by a full tree per push (2026-10-12).
func TestGitSourceResolve_ShallowMirrorFetchesOnlyWhatAPushChanged(t *testing.T) {
	src, mirror, _, _ := cacheRecoveryFixture(t)
	work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")

	// A large file that no later push touches, in its own commit.
	big := make([]byte, 2<<20)
	if _, err := rand.Read(big); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "chart", "big.bin"), big, 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "synthetic large asset")
	runGit(t, work, "push", "origin", "main")
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}
	before := packBytes(t, mirror)
	if before < 2<<20 {
		t.Fatalf("the mirror holds %d pack bytes, want the 2 MiB asset in it", before)
	}

	next := pushChartChange(t, mirror, "synthetic-small-change")
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != next {
		t.Fatalf("resolved %s, want %s", got.Revision, next)
	}
	if grew := packBytes(t, mirror) - before; grew > 64<<10 {
		t.Fatalf("a one-line push grew the mirror by %d bytes, want only the change (< 64 KiB)", grew)
	}
}

// A branch force-pushed onto history with nothing in common with the mirror
// still resolves to its new tip: the incremental fetch then brings that
// history in full.
func TestGitSourceResolve_ShallowMirrorFollowsAForcePushOntoUnrelatedHistory(t *testing.T) {
	src, mirror, _, first := cacheRecoveryFixture(t)
	work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
	runGit(t, work, "checkout", "--orphan", "rewrite")
	writeChartFile(t, work, "synthetic-rewritten-history")
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "synthetic unrelated root")
	runGit(t, work, "push", "--force", "origin", "rewrite:main")
	next := gitOutput(t, work, "rev-parse", "HEAD")
	if next == first {
		t.Fatal("the fixture did not move")
	}
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatalf("resolve after a force push: %v", err)
	}
	if got.Revision != next {
		t.Fatalf("resolved %s, want the force-pushed tip %s", got.Revision, next)
	}
	body, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "synthetic-rewritten-history") {
		t.Fatalf("the checkout does not hold the rewritten chart: %q", body)
	}
}
