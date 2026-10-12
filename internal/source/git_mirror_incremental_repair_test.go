package source

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"
	gitclient "github.com/go-git/go-git/v5/plumbing/transport/client"
	"github.com/go-git/go-git/v5/storage/memory"
)

// oneTreeSlack bounds the growth of a repair: the tip's tree (one 1 MiB
// blob in rollbackFixture) and its commit, not the history behind it.
const oneTreeSlack = 1<<20 + 256<<10

// writeRepoFile writes body to rel under work, creating its directories.
func writeRepoFile(t *testing.T, work, rel, body string) {
	t.Helper()
	p := filepath.Join(work, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// checkedOutFiles lists the files under root, relative and sorted.
func checkedOutFiles(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, relErr := filepath.Rel(root, p)
			if relErr != nil {
				return relErr
			}
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// originFiles lists the files of HEAD in work under dir ("" for all of them),
// relative to dir and sorted.
func originFiles(t *testing.T, work, dir string) []string {
	t.Helper()
	args := []string{"ls-tree", "-r", "--name-only", "HEAD"}
	if dir != "" {
		args = append(args, dir+"/")
	}
	names := strings.Fields(gitOutput(t, work, args...))
	out := make([]string, 0, len(names))
	for _, name := range names {
		if dir != "" {
			name = strings.TrimPrefix(name, dir+"/")
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// newOrigin creates a bare origin and a work clone pushing to it.
func newOrigin(t *testing.T) (root, origin, work string) {
	t.Helper()
	root = t.TempDir()
	origin, work = filepath.Join(root, "origin.git"), filepath.Join(root, "work")
	runGit(t, root, "init", "--bare", "--initial-branch=main", origin)
	runGit(t, root, "init", "--initial-branch=main", work)
	runGit(t, work, "config", "user.email", "synthetic@example.test")
	runGit(t, work, "config", "user.name", "Synthetic Test")
	runGit(t, work, "remote", "add", "origin", origin)
	return root, origin, work
}

func commitAll(t *testing.T, work, msg string) string {
	t.Helper()
	runGit(t, work, "add", "-A")
	runGit(t, work, "commit", "-q", "-m", msg)
	return gitOutput(t, work, "rev-parse", "HEAD")
}

// markMirror drops a sentinel into the mirror; mirrorWasReset reports whether
// a cache reset has since removed it.
func markMirror(t *testing.T, mirror string) string {
	t.Helper()
	sentinel := filepath.Join(mirror, "synthetic-sentinel")
	if err := os.WriteFile(sentinel, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return sentinel
}

func mirrorWasReset(sentinel string) bool {
	_, err := os.Stat(sentinel)
	return os.IsNotExist(err)
}

// rollbackFixture is the main-following source on a shallow mirror cloned
// fresh at the tip of five commits, each replacing chart/big.bin with 1 MiB
// of random bytes, so one tree is about 1 MiB and the history about 5 MiB.
// It returns the source, the mirror, the work clone and the commits, oldest
// first.
func rollbackFixture(t *testing.T) (*GitSource, string, string, []string) {
	t.Helper()
	src, mirror, worktree, first := cacheRecoveryFixture(t)
	work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
	commits := []string{first}
	for i := 0; i < 4; i++ {
		big := make([]byte, 1<<20)
		if _, err := rand.Read(big); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(work, "chart", "big.bin"), big, 0o600); err != nil {
			t.Fatal(err)
		}
		commits = append(commits, commitAll(t, work, "synthetic large asset"))
	}
	runGit(t, work, "push", "origin", "main")
	// A fresh mirror, as after a repo-server restart: its shallow boundary is
	// the tip, and nothing below it is in the mirror.
	if err := resetGitCache(mirror, worktree); err != nil {
		t.Fatal(err)
	}
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != commits[4] {
		t.Fatalf("resolved %s, want the tip %s", got.Revision, commits[4])
	}
	return src, mirror, work, commits
}

// filesAt lists the files of rev in the bare repository gitDir under dir
// ("" for all of them), relative to dir and sorted.
func filesAt(t *testing.T, gitDir, rev, dir string) []string {
	t.Helper()
	args := []string{"--git-dir", gitDir, "ls-tree", "-r", "--name-only", rev}
	if dir != "" {
		args = append(args, dir+"/")
	}
	names := strings.Fields(gitOutput(t, filepath.Dir(gitDir), args...))
	out := make([]string, 0, len(names))
	for _, name := range names {
		out = append(out, strings.TrimPrefix(name, dir+"/"))
	}
	sort.Strings(out)
	return out
}

// assertRepairedWithinOneTree resolves src once and requires the wanted
// revision on the first try with its complete file set, an unreset mirror,
// and growth of at most about one tree.
func assertRepairedWithinOneTree(t *testing.T, src *GitSource, mirror, want string) {
	t.Helper()
	assertResolvedWithin(t, src, mirror, want, oneTreeSlack)
}

// assertResolvedWithin is assertRepairedWithinOneTree with a growth bound of
// maxGrowth bytes.
func assertResolvedWithin(t *testing.T, src *GitSource, mirror, want string, maxGrowth int64) {
	t.Helper()
	sentinel := markMirror(t, mirror)
	before := packBytes(t, mirror)
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Revision != want {
		t.Fatalf("resolved %s, want %s", got.Revision, want)
	}
	if files, wantFiles := checkedOutFiles(t, got.LocalPath), filesAt(t, src.RepoURL, want, src.Path); !reflect.DeepEqual(files, wantFiles) {
		t.Fatalf("checked out %v, want %v", files, wantFiles)
	}
	if mirrorWasReset(sentinel) {
		t.Fatal("the mirror was wiped and re-cloned, want it kept")
	}
	if grew := packBytes(t, mirror) - before; grew > maxGrowth {
		t.Fatalf("the mirror grew by %d bytes, want <= %d", grew, maxGrowth)
	}
}

// A rebase that drops a commit leaves the new tip on a parent below the
// shallow boundary, so a depth-0 fetch leaves out the subtrees the tip shares
// with that parent. The checkout must hold the whole tree, never a silently
// truncated one.
func TestGitSourceResolve_RebaseBelowTheShallowBoundaryChecksOutTheWholeTree(t *testing.T) {
	for _, path := range []string{"chart", ""} {
		t.Run("path="+path, func(t *testing.T) {
			root, origin, work := newOrigin(t)
			writeRepoFile(t, work, "README.md", "synthetic\n")
			writeRepoFile(t, work, "chart/Chart.yaml", "name: synthetic\n")
			writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment\n")
			writeRepoFile(t, work, "chart/templates/svc.yaml", "kind: Service\n")
			writeRepoFile(t, work, "chart/values.yaml", "replicas: 1\n")
			commitAll(t, work, "c0")
			writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment # synthetic change\n")
			commitAll(t, work, "c1")
			writeRepoFile(t, work, "chart/values.yaml", "replicas: 2\n")
			c2 := commitAll(t, work, "c2")
			runGit(t, work, "push", "origin", "main")
			src := &GitSource{RepoURL: origin, Revision: "main", Path: path, WorkDir: filepath.Join(root, "cache"), Shallow: true}
			if _, err := resolveWithin(t, src); err != nil {
				t.Fatal(err)
			}

			// Drop c1.
			runGit(t, work, "reset", "--hard", "HEAD~2")
			runGit(t, work, "cherry-pick", c2)
			runGit(t, work, "push", "--force", "origin", "main")
			want := gitOutput(t, work, "rev-parse", "HEAD")
			wantFiles := originFiles(t, work, path)

			mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, ""))
			sentinel := markMirror(t, mirror)
			for _, try := range []string{"first", "second"} {
				got, err := resolveWithin(t, src)
				if err != nil {
					t.Fatalf("%s resolve: %v", try, err)
				}
				if got.Revision != want {
					t.Fatalf("%s resolve: resolved %s, want %s", try, got.Revision, want)
				}
				if files := checkedOutFiles(t, got.LocalPath); !reflect.DeepEqual(files, wantFiles) {
					t.Fatalf("%s resolve: checked out %v, want %v", try, files, wantFiles)
				}
				if mirrorWasReset(sentinel) {
					t.Fatalf("%s resolve: the mirror was wiped, want the tip's tree re-fetched in place", try)
				}
			}
		})
	}
}

// The tip's tree is re-fetched in place for a GitHub App source whose client
// gave up during the fetch before it: refetchTip mints its token under the
// detached fetch context, as the fetch did, so the token exchange does not
// fail on the request's ended context and send the mirror to the wipe.
func TestGitSourceResolve_TipRefetchOutlivesItsClient(t *testing.T) {
	root, origin, work := newOrigin(t)
	writeRepoFile(t, work, "chart/Chart.yaml", "name: synthetic\n")
	writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment\n")
	writeRepoFile(t, work, "chart/values.yaml", "replicas: 1\n")
	commitAll(t, work, "c0")
	writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment # synthetic change\n")
	commitAll(t, work, "c1")
	writeRepoFile(t, work, "chart/values.yaml", "replicas: 2\n")
	c2 := commitAll(t, work, "c2")
	runGit(t, work, "push", "origin", "main")
	tokens := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, `{"token":"ghs_synthetic"}`)
	}))
	t.Cleanup(tokens.Close)
	src := &GitSource{
		RepoURL: origin, Revision: "main", Path: "chart", WorkDir: filepath.Join(root, "cache"), Shallow: true,
		Auth: GitAuth{GitHubApp: &GitHubAppAuth{
			AppID: 1, InstallationID: 2, PrivateKey: generateTestPrivateKey(t), EnterpriseURL: tokens.URL,
		}},
	}
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}

	// Drop c1, so the new tip's templates/ tree is below the boundary.
	runGit(t, work, "reset", "--hard", "HEAD~2")
	runGit(t, work, "cherry-pick", c2)
	runGit(t, work, "push", "--force", "origin", "main")
	want := gitOutput(t, work, "rev-parse", "HEAD")

	mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, src.credentialID()))
	sentinel := markMirror(t, mirror)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	installSessionTransport(t, &sessionTransport{target: origin, cancel: cancel})
	got, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Revision != want {
		t.Fatalf("resolved %s, want %s", got.Revision, want)
	}
	if files, wantFiles := checkedOutFiles(t, got.LocalPath), originFiles(t, work, "chart"); !reflect.DeepEqual(files, wantFiles) {
		t.Fatalf("checked out %v, want %v", files, wantFiles)
	}
	if mirrorWasReset(sentinel) {
		t.Fatal("the mirror was wiped, want the tip's tree re-fetched in place")
	}
}

// A nested Path whose intermediate tree only the commit below the boundary
// carries: the missing tree is a recoverable cache error, never "is not a
// directory".
func TestGitSourceResolve_NestedPathWhoseTreeIsBelowTheShallowBoundary(t *testing.T) {
	root, origin, work := newOrigin(t)
	writeRepoFile(t, work, "charts/app/values.yaml", "v: c1\n")
	writeRepoFile(t, work, "README", "r1\n")
	c1 := commitAll(t, work, "c1")
	writeRepoFile(t, work, "charts/app/values.yaml", "v: c2\n")
	commitAll(t, work, "c2")
	runGit(t, work, "push", "origin", "main")
	src := &GitSource{RepoURL: origin, Revision: "main", Path: "charts/app", WorkDir: filepath.Join(root, "cache"), Shallow: true}
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}

	// Back to c1, plus a commit that touches only the root.
	runGit(t, work, "reset", "--hard", c1)
	writeRepoFile(t, work, "README", "r5\n")
	want := commitAll(t, work, "c5")
	runGit(t, work, "push", "--force", "origin", "main")

	sentinel := markMirror(t, filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, "")))
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Revision != want {
		t.Fatalf("resolved %s, want %s", got.Revision, want)
	}
	if mirrorWasReset(sentinel) {
		t.Fatal("the mirror was wiped, want the tip's tree re-fetched in place")
	}
	body, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "v: c1\n" {
		t.Fatalf("values.yaml = %q, want c1's", body)
	}
}

// A branch force-pushed back below the shallow boundary (a rollback) gets an
// empty pack from a depth-0 fetch. The ref is re-fetched at depth 1, which
// costs one tree, as a first clone does: never a failed resolve, a cached
// failure, a wiped mirror or the full history.
func TestGitSourceResolve_BranchRolledBackBelowTheShallowBoundary(t *testing.T) {
	cases := []struct {
		name     string
		revision string
		fetchTTL time.Duration
		pinned   bool
	}{
		{name: "main", revision: "main"},
		{name: "main with a fetch TTL", revision: "main", fetchTTL: time.Hour},
		{name: "HEAD", revision: ""},
		{name: "main beside a pinned sibling", revision: "main", pinned: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, work, commits := rollbackFixture(t)
			if tc.pinned {
				// As on GitHub, which serves a pinned commit by its SHA.
				runGit(t, work, "--git-dir", src.RepoURL, "config", "uploadpack.allowReachableSHA1InWant", "true")
				pinned := &GitSource{RepoURL: src.RepoURL, Revision: commits[4], Path: "chart", WorkDir: src.WorkDir, Shallow: true}
				if _, err := resolveWithin(t, pinned); err != nil {
					t.Fatalf("pinned sibling: %v", err)
				}
			}
			follower := &GitSource{
				RepoURL: src.RepoURL, Revision: tc.revision, Path: "chart",
				WorkDir: src.WorkDir, Shallow: true, FetchTTL: tc.fetchTTL,
			}
			if got, err := resolveWithin(t, follower); err != nil || got.Revision != commits[4] {
				t.Fatalf("resolve before the rollback: %v, %v", got, err)
			}

			runGit(t, work, "push", "--force", "origin", commits[2]+":refs/heads/main")
			// The rollback lands after the TTL has run out.
			if err := os.Remove(fetchClockFile(mirror)); err != nil {
				t.Fatal(err)
			}
			assertRepairedWithinOneTree(t, follower, mirror, commits[2])
			if got, err := resolveWithin(t, follower); err != nil || got.Revision != commits[2] {
				t.Fatalf("second resolve: %v, %v", got, err)
			}
		})
	}
}

// A tag moved back below the boundary of a mirror that also holds main
// resolves on the first try, for one tree, however the revision names it. A
// full refs/tags/ name has no shallow depth of its own (depth() is 0), so
// this pins the repair's explicit depth 1. A pinned SHA moved back is the
// same move for a source that names commits.
func TestGitSourceResolve_TagMovedBackBelowTheShallowBoundary(t *testing.T) {
	for _, revision := range []string{"v1", "refs/tags/v1", "sha"} {
		t.Run(revision, func(t *testing.T) {
			src, mirror, work, commits := rollbackFixture(t)
			runGit(t, work, "tag", "v1", commits[4])
			runGit(t, work, "push", "origin", "v1")
			// As on GitHub, which serves a pinned commit by its SHA.
			runGit(t, work, "--git-dir", src.RepoURL, "config", "uploadpack.allowReachableSHA1InWant", "true")
			tag := &GitSource{RepoURL: src.RepoURL, Revision: revision, Path: "chart", WorkDir: src.WorkDir, Shallow: true}
			if revision == "sha" {
				tag.Revision = commits[4]
			}
			if got, err := resolveWithin(t, tag); err != nil || got.Revision != commits[4] {
				t.Fatalf("resolve before the move: %v, %v", got, err)
			}

			if revision == "sha" {
				tag.Revision = commits[2]
			} else {
				runGit(t, work, "tag", "-f", "v1", commits[2])
				runGit(t, work, "push", "--force", "origin", "v1")
			}
			assertRepairedWithinOneTree(t, tag, mirror, commits[2])
			if got, err := resolveWithin(t, src); err != nil || got.Revision != commits[4] {
				t.Fatalf("main after the tag repair: %v, %v", got, err)
			}
		})
	}
}

// A second source on a short tag at an ancestor of main, on a mirror main
// cloned first: the tag's commit is below the boundary, and a depth-0 fetch
// alone leaves refs/tags/<tag> pointing at nothing.
func TestGitSourceResolve_ShortTagBelowTheShallowBoundaryOfASharedMirror(t *testing.T) {
	for _, annotated := range []bool{false, true} {
		name := "lightweight"
		if annotated {
			name = "annotated"
		}
		t.Run(name, func(t *testing.T) {
			root, origin, work := newOrigin(t)
			writeChartFile(t, work, "synthetic-base")
			commitAll(t, work, "base")
			writeChartFile(t, work, "synthetic-tagged")
			tagged := commitAll(t, work, "tagged")
			writeChartFile(t, work, "synthetic-tip")
			commitAll(t, work, "tip")
			if annotated {
				runGit(t, work, "tag", "-a", "-m", "synthetic release", "v0", tagged)
			} else {
				runGit(t, work, "tag", "v0", tagged)
			}
			runGit(t, work, "push", "origin", "main", "v0")

			cache := filepath.Join(root, "cache")
			main := &GitSource{RepoURL: origin, Revision: "main", Path: "chart", WorkDir: cache, Shallow: true}
			if _, err := resolveWithin(t, main); err != nil {
				t.Fatal(err)
			}
			mirror := filepath.Join(cache, "git-mirrors", RepoCacheKey(origin, ""))
			tag := &GitSource{RepoURL: origin, Revision: "v0", Path: "chart", WorkDir: cache, Shallow: true}
			assertRepairedWithinOneTree(t, tag, mirror, tagged)
			got, err := resolveWithin(t, tag)
			if err != nil {
				t.Fatalf("second resolve: %v", err)
			}
			body, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(body), "synthetic-tagged") {
				t.Fatalf("values.yaml = %q, want the tagged chart", body)
			}
		})
	}
}

// A fetch that returns no error but leaves the revision unresolvable must not
// stamp the fetch clock, or a FetchTTL caches the failure for its whole span:
// neither the fetch into an existing mirror nor the one that creates it.
func TestGitSourceResolve_MissingRevisionDoesNotStampTheFetchClock(t *testing.T) {
	for _, fresh := range []bool{false, true} {
		name := "existing mirror"
		if fresh {
			name = "fresh mirror"
		}
		t.Run(name, func(t *testing.T) {
			src, mirror, worktree, _ := cacheRecoveryFixture(t)
			work := filepath.Join(filepath.Dir(filepath.Dir(mirror)), "..", "work")
			// A tag on a commit no branch holds.
			runGit(t, work, "commit", "--allow-empty", "-m", "synthetic tagged commit")
			runGit(t, work, "tag", "v1")
			runGit(t, work, "reset", "--hard", "HEAD~1")
			runGit(t, work, "push", "origin", "v1")
			// An all-heads fetch never fetches the tag, and returns no error.
			allHeads := &GitSource{
				RepoURL: src.RepoURL, Revision: "v1", Path: "chart", WorkDir: src.WorkDir,
				Shallow: true, FetchAllRefs: true, FetchTTL: time.Hour,
			}
			if err := os.Remove(fetchClockFile(mirror)); err != nil {
				t.Fatal(err)
			}
			if fresh {
				if err := resetGitCache(mirror, worktree); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := resolveWithin(t, allHeads); err == nil {
				t.Fatal("resolved a tag an all-heads mirror never fetched")
			}
			if _, err := os.Stat(fetchClockFile(mirror)); !os.IsNotExist(err) {
				t.Fatalf("the fetch clock was stamped for a revision the fetch left missing (stat: %v)", err)
			}
		})
	}
}

// A source pinned to a commit below the boundary of a mirror another source
// cloned resolves on its first try, for one tree. Here refs/paprika-pinned/<sha>
// already exists, left on a commit the mirror lacks, so the fetch must move it
// with no fast-forward check: go-git cannot read the new commit to make one
// (it is below the boundary, and a depth-0 fetch sends an empty pack), and an
// unforced update fails the fetch. A bitmapped origin (GitHub) answers the
// same way. An all-heads source fetches no pinned ref, so the commit comes
// from fetchPinnedCommit, whose refspec alone forces the update.
func TestGitSourceResolve_PinnedSHABelowTheShallowBoundary(t *testing.T) {
	cases := []struct {
		name         string
		bitmaps      bool
		fetchAllRefs bool
	}{
		{name: "bitmaps=false"},
		{name: "bitmaps=true", bitmaps: true},
		{name: "all heads", fetchAllRefs: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, work, commits := rollbackFixture(t)
			runGit(t, work, "--git-dir", src.RepoURL, "config", "uploadpack.allowReachableSHA1InWant", "true")
			if tc.bitmaps {
				runGit(t, work, "--git-dir", src.RepoURL, "repack", "-adb")
			}
			ref := filepath.Join(mirror, filepath.FromSlash(pinnedCommitRefPrefix+commits[2]))
			if err := os.MkdirAll(filepath.Dir(ref), 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(ref, []byte(strings.Repeat("0123456789", 4)+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			pinned := &GitSource{
				RepoURL: src.RepoURL, Revision: commits[2], Path: "chart", WorkDir: src.WorkDir,
				Shallow: true, FetchAllRefs: tc.fetchAllRefs,
			}
			assertRepairedWithinOneTree(t, pinned, mirror, commits[2])
		})
	}
}

// A Path whose tree only a commit below the boundary carries arrives without
// that tree from a depth-0 fetch. The tip's tree is re-fetched at depth 1 in
// place: never "directory not found", a truncated checkout, or a wiped
// mirror.
func TestGitSourceResolve_PathScopeTreeBelowTheShallowBoundary(t *testing.T) {
	t.Run("a rebase drops the only commit that touched it", func(t *testing.T) {
		root, origin, work := newOrigin(t)
		writeRepoFile(t, work, "README.md", "synthetic\n")
		writeRepoFile(t, work, "chart/Chart.yaml", "name: synthetic\n")
		writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment\n")
		writeRepoFile(t, work, "chart/values.yaml", "replicas: 1\n")
		commitAll(t, work, "c0")
		writeRepoFile(t, work, "chart/values.yaml", "replicas: 2\n")
		commitAll(t, work, "c1")
		writeRepoFile(t, work, "README.md", "synthetic, edited\n")
		c2 := commitAll(t, work, "c2")
		runGit(t, work, "push", "origin", "main")
		src := &GitSource{RepoURL: origin, Revision: "main", Path: "chart", WorkDir: filepath.Join(root, "cache"), Shallow: true}
		if _, err := resolveWithin(t, src); err != nil {
			t.Fatal(err)
		}

		// Drop c1: the new tip's chart/ is c0's, below the boundary.
		runGit(t, work, "reset", "--hard", "HEAD~2")
		runGit(t, work, "cherry-pick", c2)
		runGit(t, work, "push", "--force", "origin", "main")
		want := gitOutput(t, work, "rev-parse", "HEAD")
		mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, ""))
		assertRepairedWithinOneTree(t, src, mirror, want)
		got, err := resolveWithin(t, src)
		if err != nil {
			t.Fatalf("second resolve: %v", err)
		}
		body, err := os.ReadFile(filepath.Join(got.LocalPath, "values.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "replicas: 1\n" {
			t.Fatalf("values.yaml = %q, want c0's", body)
		}
	})

	// A bitmapped server leaves out everything the mirror's tip reaches,
	// below the boundary too, so a revert arrives without the tree it
	// restores: the Path's tree, or with no Path the root tree itself. A
	// source pinned to the revert gets it the same way, under its own ref,
	// and so does an annotated tag moved onto it, which refetchTip must
	// hide as well as the commit: go-git wants only a missing object.
	for _, tc := range []struct{ path, pin string }{
		{path: "chart"}, {path: ""}, {path: "chart", pin: "pinned"}, {path: "chart", pin: "annotated tag"},
	} {
		path, name := tc.path, "a revert on a bitmapped origin, path="+tc.path
		if tc.pin != "" {
			name += ", " + tc.pin
		}
		t.Run(name, func(t *testing.T) {
			root, origin, work := newOrigin(t)
			big := make([]byte, 1<<20)
			if _, err := rand.Read(big); err != nil {
				t.Fatal(err)
			}
			writeRepoFile(t, work, "assets/big.bin", string(big))
			writeRepoFile(t, work, "chart/templates/deploy.yaml", "kind: Deployment\n")
			writeRepoFile(t, work, "chart/values.yaml", "value: A\n")
			commitAll(t, work, "c0")
			writeRepoFile(t, work, "chart/values.yaml", "value: B\n")
			c1 := commitAll(t, work, "c1")
			revision := "main"
			if tc.pin == "annotated tag" {
				runGit(t, work, "tag", "-a", "-m", "synthetic release", "v1")
				revision = "v1"
			}
			runGit(t, work, "push", "origin", "main", "--tags")
			runGit(t, work, "--git-dir", origin, "repack", "-adb")
			src := &GitSource{RepoURL: origin, Revision: revision, Path: path, WorkDir: filepath.Join(root, "cache"), Shallow: true}
			if _, err := resolveWithin(t, src); err != nil {
				t.Fatal(err)
			}

			runGit(t, work, "revert", "--no-edit", c1)
			runGit(t, work, "push", "origin", "main")
			if tc.pin == "annotated tag" {
				runGit(t, work, "tag", "-f", "-a", "-m", "synthetic release", "v1")
				runGit(t, work, "push", "--force", "origin", "v1")
			}
			runGit(t, work, "--git-dir", origin, "repack", "-adb")
			want := gitOutput(t, work, "rev-parse", "HEAD")
			if tc.pin == "pinned" {
				runGit(t, work, "--git-dir", origin, "config", "uploadpack.allowReachableSHA1InWant", "true")
				src = &GitSource{RepoURL: origin, Revision: want, Path: path, WorkDir: src.WorkDir, Shallow: true}
			}
			mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, ""))
			assertRepairedWithinOneTree(t, src, mirror, want)
		})
	}
}

// A mirror only an annotated tag uses fetches only what a forward move of the
// tag changed. go-git offers no annotated tag as a have (it reads every have
// as a commit), so without the tag's commit under a ref of its own the
// server sent the tag's whole history.
func TestGitSourceResolve_AnnotatedTagAloneFetchesOnlyWhatAMoveChanged(t *testing.T) {
	root, origin, work := newOrigin(t)
	for i := 0; i < 2; i++ {
		big := make([]byte, 1<<20)
		if _, err := rand.Read(big); err != nil {
			t.Fatal(err)
		}
		writeRepoFile(t, work, "chart/big.bin", string(big))
		writeChartFile(t, work, fmt.Sprintf("synthetic-%d", i))
		commitAll(t, work, fmt.Sprintf("c%d", i))
	}
	runGit(t, work, "tag", "-a", "-m", "synthetic release", "v1")
	runGit(t, work, "push", "origin", "main", "v1")
	src := &GitSource{RepoURL: origin, Revision: "v1", Path: "chart", WorkDir: filepath.Join(root, "cache"), Shallow: true}
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}
	mirror := filepath.Join(src.WorkDir, "git-mirrors", RepoCacheKey(origin, ""))
	before := packBytes(t, mirror)

	writeChartFile(t, work, "synthetic-moved")
	next := commitAll(t, work, "c2")
	runGit(t, work, "tag", "-f", "-a", "-m", "synthetic release", "v1")
	runGit(t, work, "push", "--force", "origin", "v1")
	got, err := resolveWithin(t, src)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != next {
		t.Fatalf("resolved %s, want %s", got.Revision, next)
	}
	if grew := packBytes(t, mirror) - before; grew > 64<<10 {
		t.Fatalf("a one-line move grew the mirror by %d bytes, want only the change (< 64 KiB)", grew)
	}
}

// The repair looks only at the refs the fetch before it wrote: a HEAD source
// never re-fetches a sibling branch it does not fetch, and a ref on an object
// that is not a commit is not a dangling ref to re-want on every fetch.
func TestGitSourceResolve_RepairLooksOnlyAtTheRefsItFetched(t *testing.T) {
	cases := []struct {
		name         string
		revision     string
		fetchAllRefs bool
		ref          string
		blob         bool
	}{
		{name: "HEAD beside a dangling sibling branch", revision: "", ref: "refs/heads/sibling"},
		{name: "all heads beside a branch on a blob", revision: "main", fetchAllRefs: true, ref: "refs/heads/blob", blob: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, _, _ := cacheRecoveryFixture(t)
			target := strings.Repeat("0123456789", 4)
			if tc.blob {
				target = gitOutput(t, mirror, "rev-parse", "refs/heads/main:chart/values.yaml")
			}
			ref := filepath.Join(mirror, filepath.FromSlash(tc.ref))
			if err := os.WriteFile(ref, []byte(target+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			counting := &sessionTransport{target: src.RepoURL}
			installSessionTransport(t, counting)
			follower := &GitSource{
				RepoURL: src.RepoURL, Revision: tc.revision, Path: "chart",
				WorkDir: src.WorkDir, Shallow: true, FetchAllRefs: tc.fetchAllRefs,
			}
			if _, err := resolveWithin(t, follower); err != nil {
				t.Fatal(err)
			}
			if counting.sessions != 1 {
				t.Fatalf("the resolve opened %d upload-pack sessions, want 1: no repair of %s", counting.sessions, tc.ref)
			}
		})
	}
}

// failingRepairTransport fails the failAt'th upload-pack session on target,
// after leaving a partial pack in mirror, as a fetch cut off mid-pack does.
type failingRepairTransport struct {
	transport.Transport
	target, mirror string
	failAt         int
	sessions       int
}

var errSyntheticRepair = errors.New("synthetic repair fetch failure")

func (f *failingRepairTransport) NewUploadPackSession(ep *transport.Endpoint, auth transport.AuthMethod) (transport.UploadPackSession, error) {
	if filepath.Clean(ep.Path) == filepath.Clean(f.target) {
		f.sessions++
		if f.sessions == f.failAt {
			partial := filepath.Join(f.mirror, "objects", "pack", "tmp_pack_synthetic")
			if err := os.WriteFile(partial, []byte("partial"), 0o600); err != nil {
				return nil, err
			}
			return nil, errSyntheticRepair
		}
	}
	return f.Transport.NewUploadPackSession(ep, auth)
}

// A repair fetch that fails fails the resolve with its error: the partial
// pack it left is removed, and the fetch clock is not stamped.
func TestGitSourceResolve_FailedRepairFetchFailsTheResolve(t *testing.T) {
	src, mirror, work, commits := rollbackFixture(t)
	runGit(t, work, "push", "--force", "origin", commits[2]+":refs/heads/main")
	if err := os.Remove(fetchClockFile(mirror)); err != nil {
		t.Fatal(err)
	}
	original := gitclient.Protocols["file"]
	failing := &failingRepairTransport{Transport: original, target: src.RepoURL, mirror: mirror, failAt: 2}
	gitclient.InstallProtocol("file", failing)
	t.Cleanup(func() { gitclient.InstallProtocol("file", original) })

	_, err := resolveWithin(t, src)
	if !errors.Is(err, errSyntheticRepair) {
		t.Fatalf("resolve error = %v, want the repair fetch's error", err)
	}
	if failing.sessions != 2 {
		t.Fatalf("the resolve opened %d upload-pack sessions, want the fetch and its repair", failing.sessions)
	}
	if partial := packFiles(t, mirror, "tmp_pack_*"); len(partial) != 0 {
		t.Fatalf("the failed repair left partial packs: %v", partial)
	}
	if _, statErr := os.Stat(fetchClockFile(mirror)); !os.IsNotExist(statErr) {
		t.Fatalf("the fetch clock was stamped after a failed repair (stat: %v)", statErr)
	}
}

// After a failed repair the next resolve repairs the ref in place, for one
// tree. Its fetch changes no ref and brings none of its wants (main offers
// the old tip as a have, so the server sends an empty pack again), so the
// repair must not be skipped as up to date, or the tag stays on a missing
// commit until it moves again.
func TestGitSourceResolve_FailedRepairIsRepairedByTheNextResolve(t *testing.T) {
	src, mirror, work, commits := rollbackFixture(t)
	runGit(t, work, "tag", "v1", commits[4])
	runGit(t, work, "push", "origin", "v1")
	tag := &GitSource{RepoURL: src.RepoURL, Revision: "v1", Path: "chart", WorkDir: src.WorkDir, Shallow: true}
	if _, err := resolveWithin(t, tag); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "tag", "-f", "v1", commits[2])
	runGit(t, work, "push", "--force", "origin", "v1")

	original := gitclient.Protocols["file"]
	failing := &failingRepairTransport{Transport: original, target: src.RepoURL, mirror: mirror, failAt: 2}
	gitclient.InstallProtocol("file", failing)
	t.Cleanup(func() { gitclient.InstallProtocol("file", original) })
	if _, err := resolveWithin(t, tag); !errors.Is(err, errSyntheticRepair) {
		t.Fatalf("resolve error = %v, want the repair fetch's error", err)
	}
	gitclient.InstallProtocol("file", original)
	assertRepairedWithinOneTree(t, tag, mirror, commits[2])
}

// A failed repair leaves the source's ref on a commit the mirror lacks, and
// it is the mirror's only ref, so the next resolve's depth-0 fetch offers no
// have and brings the ref's whole history: two trees in rollbackFixture,
// against one for a repair (accepted, see incrementalDepth). It must still
// resolve the right revision in full, without a wipe. Inside a FetchTTL it
// takes the same path: the failed resolve stamped no clock, so the next one
// fetches. A short tag is fetched by fetchMirror's fallback.
func TestGitSourceResolve_FailedRepairIsMadeGoodByTheNextFetch(t *testing.T) {
	cases := []struct {
		name     string
		ref      string
		revision string
		fetchTTL time.Duration
		failAt   int
	}{
		{name: "main", ref: "refs/heads/main", revision: "main", failAt: 2},
		{name: "main with a fetch TTL", ref: "refs/heads/main", revision: "main", fetchTTL: time.Hour, failAt: 2},
		// The branch refspec finds no ref, the tag refspec fetches it, and then
		// the repair runs.
		{name: "short tag", ref: "refs/tags/v1", revision: "v1", failAt: 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src, mirror, work, commits := rollbackFixture(t)
			if tc.revision != "main" {
				runGit(t, work, "tag", tc.revision, commits[4])
				runGit(t, work, "push", "origin", tc.revision)
				if err := resetGitCache(mirror, filepath.Join(src.WorkDir, "git-clones", filepath.Base(mirror))); err != nil {
					t.Fatal(err)
				}
			}
			src = &GitSource{
				RepoURL: src.RepoURL, Revision: tc.revision, Path: "chart",
				WorkDir: src.WorkDir, Shallow: true, FetchTTL: tc.fetchTTL,
			}
			if _, err := resolveWithin(t, src); err != nil {
				t.Fatal(err)
			}
			if refs := strings.Fields(gitOutput(t, mirror, "for-each-ref", "--format=%(refname)")); !reflect.DeepEqual(refs, []string{tc.ref}) {
				t.Fatalf("mirror refs = %v, want %s alone", refs, tc.ref)
			}
			runGit(t, work, "push", "--force", "origin", commits[2]+":"+tc.ref)
			// The move lands after the TTL has run out.
			if err := os.Remove(fetchClockFile(mirror)); err != nil {
				t.Fatal(err)
			}

			original := gitclient.Protocols["file"]
			failing := &failingRepairTransport{Transport: original, target: src.RepoURL, mirror: mirror, failAt: tc.failAt}
			gitclient.InstallProtocol("file", failing)
			t.Cleanup(func() { gitclient.InstallProtocol("file", original) })
			if _, err := resolveWithin(t, src); !errors.Is(err, errSyntheticRepair) {
				t.Fatalf("resolve error = %v, want the repair fetch's error", err)
			}
			if failing.sessions != tc.failAt {
				t.Fatalf("the resolve opened %d upload-pack sessions, want %d: the repair failed", failing.sessions, tc.failAt)
			}
			gitclient.InstallProtocol("file", original)
			if _, err := os.Stat(fetchClockFile(mirror)); !os.IsNotExist(err) {
				t.Fatalf("the failed repair stamped the fetch clock (stat: %v)", err)
			}
			assertResolvedWithin(t, src, mirror, commits[2], 2*oneTreeSlack)
		})
	}
}

// A head the mirror holds on a missing commit, deleted upstream since (a
// failed repair, then the branch removed), must not make every later push
// re-send a whole tree in an all-heads mirror: no fetch of this source's
// refspecs at depth 1 may run before the moved heads have arrived (see
// incrementalDepth).
func TestGitSourceResolve_DanglingHeadDeletedUpstreamCostsNoTreePerPush(t *testing.T) {
	src, mirror, work, _ := rollbackFixture(t)
	follower := &GitSource{RepoURL: src.RepoURL, Revision: "main", Path: "chart", WorkDir: src.WorkDir, Shallow: true, FetchAllRefs: true}
	if _, err := resolveWithin(t, follower); err != nil {
		t.Fatal(err)
	}
	gone := filepath.Join(mirror, "refs", "heads", "gone")
	if err := os.WriteFile(gone, []byte(strings.Repeat("0123456789", 4)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := range 3 {
		writeChartFile(t, work, fmt.Sprintf("synthetic-push-%d", i))
		runGit(t, work, "add", ".")
		runGit(t, work, "commit", "-m", "synthetic small change")
		runGit(t, work, "push", "origin", "main")
		assertResolvedWithin(t, follower, mirror, gitOutput(t, work, "rev-parse", "HEAD"), 64<<10)
	}
}

// A HEAD source whose refs/paprika-default/HEAD names a commit the mirror
// lacks does not stamp the fetch clock: HEAD resolves to a hash without
// reading the commit, so the guard must read it.
func TestGitSourceResolve_HEADOnAMissingCommitDoesNotStampTheFetchClock(t *testing.T) {
	mirror := filepath.Join(t.TempDir(), "mirror")
	repo, err := git.PlainInit(mirror, true)
	if err != nil {
		t.Fatal(err)
	}
	missing := plumbing.NewHash(strings.Repeat("0123456789", 4))
	if err := repo.Storer.SetReference(plumbing.NewHashReference(defaultMirrorRef, missing)); err != nil {
		t.Fatal(err)
	}
	if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, defaultMirrorRef)); err != nil {
		t.Fatal(err)
	}
	(&GitSource{}).touchFetchClockIfResolvable(repo, mirror)
	if _, err := os.Stat(fetchClockFile(mirror)); !os.IsNotExist(err) {
		t.Fatalf("the fetch clock was stamped for a HEAD on a missing commit (stat: %v)", err)
	}
}

// storeObject writes o into repo and returns its hash.
func storeObject(t *testing.T, repo *git.Repository, o interface {
	Encode(plumbing.EncodedObject) error
}) plumbing.Hash {
	t.Helper()
	obj := repo.Storer.NewEncodedObject()
	if err := o.Encode(obj); err != nil {
		t.Fatal(err)
	}
	h, err := repo.Storer.SetEncodedObject(obj)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// storeFileTree writes a tree holding one file, f, and returns its hash.
func storeFileTree(t *testing.T, repo *git.Repository) plumbing.Hash {
	t.Helper()
	blob := repo.Storer.NewEncodedObject()
	blob.SetType(plumbing.BlobObject)
	w, err := blob.Writer()
	if err != nil {
		t.Fatal(err)
	}
	if _, writeErr := w.Write([]byte("synthetic\n")); writeErr != nil {
		t.Fatal(writeErr)
	}
	if closeErr := w.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	h, err := repo.Storer.SetEncodedObject(blob)
	if err != nil {
		t.Fatal(err)
	}
	return storeObject(t, repo, &object.Tree{Entries: []object.TreeEntry{{Name: "f", Mode: filemode.Regular, Hash: h}}})
}

// A tree nested past go-git's depth cap is an error, not a recursion as deep
// as the tree: a crafted tree must not exhaust the stack.
func TestGitSourceResolve_CheckoutStopsAtTheTreeDepthCap(t *testing.T) {
	repo, err := git.Init(memory.NewStorage(), nil)
	if err != nil {
		t.Fatal(err)
	}
	h := storeFileTree(t, repo)
	for i := 0; i < 1100; i++ {
		h = storeObject(t, repo, &object.Tree{Entries: []object.TreeEntry{{Name: "d", Mode: filemode.Dir, Hash: h}}})
	}
	tree, err := object.GetTree(repo.Storer, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&GitSource{}).materializeTree(repo, tree, t.TempDir()); !errors.Is(err, object.ErrMaxTreeDepth) {
		t.Fatalf("checkout of a tree nested 1100 deep = %v, want %v", err, object.ErrMaxTreeDepth)
	}
}

// A tree entry named to escape the checkout or write repository metadata is
// rejected, never written: a directory, a file or a symlink.
func TestGitSourceResolve_CheckoutRejectsUnsafeTreeNames(t *testing.T) {
	modes := []struct {
		name string
		mode filemode.FileMode
	}{{"dir", filemode.Dir}, {"file", filemode.Regular}, {"symlink", filemode.Symlink}}
	for _, m := range modes {
		for _, name := range []string{".git", "..", ".GIT", "../escape"} {
			t.Run(m.name+" "+name, func(t *testing.T) {
				repo, err := git.Init(memory.NewStorage(), nil)
				if err != nil {
					t.Fatal(err)
				}
				target := storeFileTree(t, repo)
				if m.mode != filemode.Dir {
					inner, treeErr := object.GetTree(repo.Storer, target)
					if treeErr != nil {
						t.Fatal(treeErr)
					}
					target = inner.Entries[0].Hash
				}
				h := storeObject(t, repo, &object.Tree{Entries: []object.TreeEntry{{Name: name, Mode: m.mode, Hash: target}}})
				tree, err := object.GetTree(repo.Storer, h)
				if err != nil {
					t.Fatal(err)
				}
				dest := filepath.Join(t.TempDir(), "checkout")
				if err := os.MkdirAll(dest, 0o750); err != nil {
					t.Fatal(err)
				}
				if err := (&GitSource{}).materializeTree(repo, tree, dest); err == nil {
					t.Fatalf("checked out a %s entry named %q", m.name, name)
				}
				if files := checkedOutFiles(t, filepath.Dir(dest)); len(files) != 0 {
					t.Fatalf("wrote %v for a %s entry named %q", files, m.name, name)
				}
			})
		}
	}
}

// A tree entry in directory mode whose object is present but is not a tree
// is a malformed tree, which no refetch repairs: a non-recoverable error that
// does not match plumbing.ErrObjectNotFound, so it can never reach refetchTip
// or the wipe. Only an absent tree is the recoverable cache error. Both the
// checkout's walk and its Path scope are held to it.
func TestGitSourceResolve_DirectoryEntryThatIsNotATreeIsNotACacheError(t *testing.T) {
	for _, tc := range []struct {
		name    string
		absent  bool
		scoped  bool
		wantErr string
	}{
		{name: "walk, a blob", wantErr: "is not a tree"},
		{name: "walk, absent", absent: true},
		{name: "path, a blob", scoped: true, wantErr: "is not a tree"},
		{name: "path, absent", scoped: true, absent: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo, err := git.Init(memory.NewStorage(), nil)
			if err != nil {
				t.Fatal(err)
			}
			inner, err := object.GetTree(repo.Storer, storeFileTree(t, repo))
			if err != nil {
				t.Fatal(err)
			}
			target := inner.Entries[0].Hash
			if tc.absent {
				target = plumbing.NewHash(strings.Repeat("0123456789", 4))
			}
			h := storeObject(t, repo, &object.Tree{Entries: []object.TreeEntry{{Name: "d", Mode: filemode.Dir, Hash: target}}})
			src := &GitSource{RepoURL: "https://example.test/synthetic.git"}
			dest := filepath.Join(t.TempDir(), "checkout")
			if tc.scoped {
				src.Path = "d/chart"
				commit := storeObject(t, repo, &object.Commit{
					Author:   object.Signature{Name: "Synthetic Test", Email: "synthetic@example.test"},
					TreeHash: h,
				})
				err = src.checkoutTree(repo, &commit, dest)
			} else {
				tree, treeErr := object.GetTree(repo.Storer, h)
				if treeErr != nil {
					t.Fatal(treeErr)
				}
				err = src.materializeTree(repo, tree, dest)
			}
			if tc.absent {
				if !errors.Is(err, plumbing.ErrObjectNotFound) || !src.isRecoverableGitCacheError(err) {
					t.Fatalf("checkout = %v, want a recoverable plumbing.ErrObjectNotFound", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("checkout = %v, want %q", err, tc.wantErr)
			}
			if errors.Is(err, plumbing.ErrObjectNotFound) || src.isRecoverableGitCacheError(err) {
				t.Fatalf("checkout = %v, a cache error: refetchTip and the wipe cannot repair a malformed tree", err)
			}
		})
	}
}

// A Path through a symlink, a file or a gitlink is not a directory: the
// same non-recoverable error as before depth-0 fetches, never a missing
// object, so a resolve neither re-fetches the tip nor wipes the shared mirror.
// go-git reads the component as a tree, and the mirror's storage reports an
// object of another type as plumbing.ErrObjectNotFound.
func TestGitSourceResolve_PathThroughANonDirectoryIsNotACacheError(t *testing.T) {
	for _, p := range []string{"link/chart", "plain.yaml/x", "vendor/sub/chart"} {
		t.Run(p, func(t *testing.T) {
			root, origin, work := newOrigin(t)
			writeRepoFile(t, work, "real/chart/Chart.yaml", "name: synthetic\n")
			writeRepoFile(t, work, "plain.yaml", "synthetic: true\n")
			if err := os.Symlink("real", filepath.Join(work, "link")); err != nil {
				t.Fatal(err)
			}
			c0 := commitAll(t, work, "c0")
			runGit(t, work, "update-index", "--add", "--cacheinfo", "160000,"+c0+",vendor/sub")
			runGit(t, work, "commit", "-q", "-m", "synthetic gitlink")
			runGit(t, work, "push", "origin", "main")
			cache := filepath.Join(root, "cache")
			good := &GitSource{RepoURL: origin, Revision: "main", Path: "real/chart", WorkDir: cache, Shallow: true}
			if _, err := resolveWithin(t, good); err != nil {
				t.Fatal(err)
			}

			mirror := filepath.Join(cache, "git-mirrors", RepoCacheKey(origin, ""))
			sentinel := markMirror(t, mirror)
			before := packBytes(t, mirror)
			counting := &sessionTransport{target: origin}
			installSessionTransport(t, counting)
			src := &GitSource{RepoURL: origin, Revision: "main", Path: p, WorkDir: cache, Shallow: true}
			_, err := resolveWithin(t, src)
			if err == nil || !strings.Contains(err.Error(), "is not a directory") {
				t.Fatalf("resolve = %v, want %q", err, "is not a directory")
			}
			if errors.Is(err, plumbing.ErrObjectNotFound) || src.isRecoverableGitCacheError(err) {
				t.Fatalf("resolve = %v, a recoverable cache error", err)
			}
			if mirrorWasReset(sentinel) {
				t.Fatal("the mirror was wiped and re-cloned for a Path that is not a directory")
			}
			if counting.sessions != 1 {
				t.Fatalf("the resolve opened %d upload-pack sessions, want 1: no refetch of the tip", counting.sessions)
			}
			if grew := packBytes(t, mirror) - before; grew != 0 {
				t.Fatalf("the mirror grew by %d bytes, want none", grew)
			}
		})
	}
}

// A checkout recorded by a marker of the earlier format may be one a missing
// subtree truncated, so it is written again once, never trusted.
func TestGitSourceResolve_EarlierCheckoutMarkerIsWrittenAgain(t *testing.T) {
	src, _, worktree, revision := cacheRecoveryFixture(t)
	values := filepath.Join(worktree, "chart", "values.yaml")
	if err := os.Remove(values); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(checkoutMarker(worktree, src.Path), []byte(revision), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveWithin(t, src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(values); err != nil {
		t.Fatalf("the checkout under an earlier marker was not written again: %v", err)
	}
}

// peelTags keeps a peeled ref for each annotated tag whose commit the mirror
// holds, none for a lightweight tag or a tag on a missing commit, and removes
// the peeled ref of a tag that is gone.
func TestGitSourceResolve_PeeledRefsFollowTheMirrorsTags(t *testing.T) {
	repo, err := git.Init(memory.NewStorage(), nil)
	if err != nil {
		t.Fatal(err)
	}
	sig := object.Signature{Name: "Synthetic Test", Email: "synthetic@example.test"}
	commit := storeObject(t, repo, &object.Commit{Author: sig, Committer: sig, TreeHash: storeFileTree(t, repo)})
	missing := plumbing.NewHash(strings.Repeat("0123456789", 4))
	setRef := func(name string, h plumbing.Hash) {
		t.Helper()
		if err := repo.Storer.SetReference(plumbing.NewHashReference(plumbing.ReferenceName(name), h)); err != nil {
			t.Fatal(err)
		}
	}
	tagOn := func(name string, target plumbing.Hash) plumbing.Hash {
		t.Helper()
		return storeObject(t, repo, &object.Tag{Name: name, Tagger: sig, Message: "synthetic release\n", TargetType: plumbing.CommitObject, Target: target})
	}
	setRef("refs/tags/annotated", tagOn("annotated", commit))
	setRef("refs/tags/gone", tagOn("gone", commit))
	setRef("refs/tags/dangling", tagOn("dangling", missing))
	setRef("refs/tags/lightweight", commit)
	peeled := func() map[string]plumbing.Hash {
		t.Helper()
		out := map[string]plumbing.Hash{}
		iter, err := repo.References()
		if err != nil {
			t.Fatal(err)
		}
		defer iter.Close()
		if err := iter.ForEach(func(ref *plumbing.Reference) error {
			if strings.HasPrefix(ref.Name().String(), peeledRefPrefix) {
				out[ref.Name().String()] = ref.Hash()
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return out
	}

	if err := peelTags(repo); err != nil {
		t.Fatal(err)
	}
	want := map[string]plumbing.Hash{peeledRefPrefix + "tags/annotated": commit, peeledRefPrefix + "tags/gone": commit}
	if got := peeled(); !reflect.DeepEqual(got, want) {
		t.Fatalf("peeled refs = %v, want %v", got, want)
	}
	if err := repo.Storer.RemoveReference("refs/tags/gone"); err != nil {
		t.Fatal(err)
	}
	if err := peelTags(repo); err != nil {
		t.Fatal(err)
	}
	delete(want, peeledRefPrefix+"tags/gone")
	if got := peeled(); !reflect.DeepEqual(got, want) {
		t.Fatalf("peeled refs after the tag was deleted = %v, want %v", got, want)
	}
}
