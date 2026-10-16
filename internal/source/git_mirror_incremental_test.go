package source

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"reflect"
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
// the shallow depth on every fetch, go-git sent deepen 1 and the mirror's
// shallow boundary, so the server re-sent the new tip's whole tree on each
// push: on omega-ha a 4.8 GB repository grew its mirror by a full tree per
// push (2026-10-12). Every source shape that shares a mirror is pinned here,
// including a moved short tag, which goes through fetchMirror's tag retry,
// and an annotated one, which go-git never offers as a have.
func TestGitSourceResolve_ShallowMirrorFetchesOnlyWhatAPushChanged(t *testing.T) {
	cases := []struct {
		name         string
		revision     string
		tag          string
		annotated    bool
		fetchAllRefs bool
	}{
		{name: "branch", revision: "main"},
		{name: "HEAD", revision: ""},
		{name: "moved short tag", revision: "stable", tag: "stable"},
		{name: "moved annotated short tag", revision: "stable", tag: "stable", annotated: true},
		{name: "all heads", revision: "main", fetchAllRefs: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, _, _ := cacheRecoveryFixture(t)
			work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
			follower := &GitSource{
				RepoURL: src.RepoURL, Revision: tc.revision, Path: "chart",
				WorkDir: src.WorkDir, Shallow: true, FetchAllRefs: tc.fetchAllRefs,
			}

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
			tagArgs := []string{"tag", "-f"}
			if tc.annotated {
				tagArgs = append(tagArgs, "-a", "-m", "synthetic release")
			}
			if tc.tag != "" {
				runGit(t, work, append(tagArgs, tc.tag)...)
				runGit(t, work, "push", "origin", tc.tag)
			}
			if _, err := resolveWithin(t, follower); err != nil {
				t.Fatal(err)
			}
			before := packBytes(t, mirror)
			if before < 2<<20 {
				t.Fatalf("the mirror holds %d pack bytes, want the 2 MiB asset in it", before)
			}

			next := pushChartChange(t, mirror, "synthetic-small-change")
			if tc.tag != "" {
				runGit(t, work, append(tagArgs, tc.tag)...)
				runGit(t, work, "push", "--force", "origin", tc.tag)
			}
			got, err := resolveWithin(t, follower)
			if err != nil {
				t.Fatal(err)
			}
			if got.Revision != next {
				t.Fatalf("resolved %s, want %s", got.Revision, next)
			}
			if grew := packBytes(t, mirror) - before; grew > 64<<10 {
				t.Fatalf("a one-line push grew the mirror by %d bytes, want only the change (< 64 KiB)", grew)
			}
		})
	}
}

// commitLargeAssets commits n times on work's checked-out branch, each commit
// replacing chart/big.bin with 1 MiB of random bytes, and returns the last.
func commitLargeAssets(t *testing.T, work string, n int) string {
	t.Helper()
	var last string
	for i := 0; i < n; i++ {
		big := make([]byte, 1<<20)
		if _, err := rand.Read(big); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(work, "chart", "big.bin"), big, 0o600); err != nil {
			t.Fatal(err)
		}
		last = commitAll(t, work, "synthetic large asset")
	}
	return last
}

// A tip with no history in common with the mirror still resolves, whole and
// in place, and its depth-0 fetch brings that history in full: about one tree
// per commit of it, the cost incrementalDepth accepts. Each bound sits just
// above its measurement: 5,245,924, 5,245,921 and 3,147,598 bytes, against
// about 1,049,200 for one of rollbackFixture's trees.
func TestGitSourceResolve_ShallowMirrorFollowsAForcePushOntoUnrelatedHistory(t *testing.T) {
	cases := []struct {
		name         string
		from         string // the new history's base: "" for an orphan root
		commits      int
		branch       string
		fetchAllRefs bool
		maxGrowth    int64
	}{
		{name: "force push onto an unrelated root", commits: 5, branch: "main", maxGrowth: 5<<20 + 64<<10},
		{name: "all heads, a new orphan branch", commits: 5, branch: "orphan", fetchAllRefs: true, maxGrowth: 5<<20 + 64<<10},
		{name: "all heads, a branch cut from main~4", from: "main~4", commits: 3, branch: "old", fetchAllRefs: true, maxGrowth: 3<<20 + 64<<10},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, work, _ := rollbackFixture(t)
			if tc.from == "" {
				runGit(t, work, "checkout", "--orphan", "rewrite")
			} else {
				runGit(t, work, "checkout", "-b", "rewrite", tc.from)
			}
			want := commitLargeAssets(t, work, tc.commits)
			runGit(t, work, "push", "--force", "origin", "rewrite:refs/heads/"+tc.branch)
			follower := &GitSource{
				RepoURL: src.RepoURL, Revision: tc.branch, Path: "chart",
				WorkDir: src.WorkDir, Shallow: true, FetchAllRefs: tc.fetchAllRefs,
			}

			sentinel := markMirror(t, mirror)
			before := packBytes(t, mirror)
			got, err := resolveWithin(t, follower)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			if got.Revision != want {
				t.Fatalf("resolved %s, want the pushed tip %s", got.Revision, want)
			}
			if files, wantFiles := checkedOutFiles(t, got.LocalPath), filesAt(t, src.RepoURL, want, "chart"); !reflect.DeepEqual(files, wantFiles) {
				t.Fatalf("checked out %v, want %v", files, wantFiles)
			}
			if mirrorWasReset(sentinel) {
				t.Fatal("the mirror was wiped and re-cloned, want the history fetched in place")
			}
			if grew := packBytes(t, mirror) - before; grew > tc.maxGrowth {
				t.Fatalf("the mirror grew by %d bytes, want at most %d", grew, tc.maxGrowth)
			}
		})
	}
}
