package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// gitOps counts the git operations the CLI backend starts.
type gitOps struct {
	mu sync.Mutex
	c  opCounts
}

type opCounts struct{ lsRemote, fetchCommit, fetchBlob int }

func (o *gitOps) snapshot() opCounts {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.c
}

// countGitOps counts, for one test, every ls-remote, commit fetch and blob
// fetch the CLI backend starts. One fetch can be several requests to the
// server (protocol v2 negotiates in rounds), so operations are counted where
// they start.
func countGitOps(t *testing.T) *gitOps {
	t.Helper()
	ops := &gitOps{}
	gitProcessStarted = func(args []string, _ int) {
		ops.mu.Lock()
		defer ops.mu.Unlock()
		switch gitOp(args) {
		case "ls-remote":
			ops.c.lsRemote++
		case "fetch":
			if strings.Contains(strings.Join(args, " "), "--stdin") {
				ops.c.fetchBlob++
			} else {
				ops.c.fetchCommit++
			}
		}
	}
	t.Cleanup(func() { gitProcessStarted = nil })
	return ops
}

// chartFixture pushes a repository whose chart is a few small files and
// whose other directories hold large random blobs, as brandbrain's tip holds
// release binaries next to a 102 KB chart. It returns the server, the work
// clone and the tip.
func chartFixture(t *testing.T) (*cliTestServer, string, string) {
	t.Helper()
	requireGitCLI(t)
	srvRoot := t.TempDir()
	srv := newCLITestServer(t, srvRoot)
	_, work := newServedOrigin(t, srvRoot, "origin.git")
	writeRepoFile(t, work, "deploy/chart/Chart.yaml", "apiVersion: v2\nname: demo\nversion: 0.1.0\n")
	writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: 1\n")
	writeRepoFile(t, work, "deploy/chart/templates/deploy.yaml", "kind: Deployment\n")
	for i := range 4 {
		randomFile(t, work, filepath.Join("releases", "app-"+string(rune('a'+i))+".bin"), 512<<10)
	}
	tip := pushAll(t, work, "initial")
	return srv, work, tip
}

// A cold resolve downloads the commit, its trees and the chart's blobs, and
// none of the 2 MiB of binaries beside the chart.
func TestCLIResolve_ColdResolveFetchesOnlyThePathsBlobs(t *testing.T) {
	srv, work, tip := chartFixture(t)
	src := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	ops := countGitOps(t)

	res := mustResolve(t, src)

	if res.Revision != tip {
		t.Fatalf("revision = %s, want %s", res.Revision, tip)
	}
	if got, want := checkedOutFiles(t, res.LocalPath), originFiles(t, work, "deploy/chart"); !reflect.DeepEqual(got, want) {
		t.Fatalf("checked out %v, want %v", got, want)
	}
	values, err := os.ReadFile(filepath.Join(res.LocalPath, "values.yaml"))
	if err != nil || string(values) != "replicas: 1\n" {
		t.Fatalf("values.yaml = %q, %v", values, err)
	}
	if o := ops.snapshot(); o.lsRemote != 1 || o.fetchCommit != 1 || o.fetchBlob != 1 {
		t.Fatalf("started %+v, want one ls-remote, one commit fetch and one blob fetch", o)
	}
	c := srv.counts()
	if c.blobWants != 3 {
		t.Fatalf("blob fetch wanted %d objects, want the chart's 3", c.blobWants)
	}
	if c.sent > 64<<10 {
		t.Fatalf("server sent %d bytes; the chart and its trees are a few KB, the binaries 2 MiB", c.sent)
	}
	if missing := missingObjects(t, cliMirrorDir(src), tip); len(missing) != 4 {
		t.Fatalf("mirror lacks %d objects, want exactly the 4 binaries", len(missing))
	}
}

// The CLI backend reports the same revision and hash as the go-git backend
// for the same content, so switching backends starts no release.
func TestCLIResolve_HashMatchesTheGoGitBackend(t *testing.T) {
	requireGitCLI(t)
	_, origin, work := newOrigin(t)
	writeRepoFile(t, work, "chart/Chart.yaml", "apiVersion: v2\nname: demo\nversion: 0.1.0\n")
	writeRepoFile(t, work, "chart/templates/a.yaml", "a: 1\n")
	writeRepoFile(t, work, "chart/files/run.sh", "#!/bin/sh\necho hi\n")
	if err := os.Chmod(filepath.Join(work, "chart/files/run.sh"), 0o755); err != nil { // #nosec G302 -- an executable fixture
		t.Fatal(err)
	}
	if err := os.Symlink("templates/a.yaml", filepath.Join(work, "chart/link.yaml")); err != nil {
		t.Fatal(err)
	}
	randomFile(t, work, "other/big.bin", 256<<10)
	commitAll(t, work, "chart")
	runGit(t, work, "push", "--quiet", "origin", "main")

	for _, path := range []string{"chart", "chart/templates", ""} {
		goGit := &GitSource{RepoURL: origin, Revision: "main", Path: path, WorkDir: t.TempDir(), Shallow: true, Backend: GitBackendGoGit}
		cli := cliSource(origin, "main", path, t.TempDir())
		want, got := mustResolve(t, goGit), mustResolve(t, cli)
		if got.Hash != want.Hash || got.Revision != want.Revision {
			t.Fatalf("path %q: cli = %s@%s, go-git = %s@%s", path, got.Hash, got.Revision, want.Hash, want.Revision)
		}
		if a, b := checkedOutFiles(t, got.LocalPath), checkedOutFiles(t, want.LocalPath); !reflect.DeepEqual(a, b) {
			t.Fatalf("path %q: cli wrote %v, go-git %v", path, a, b)
		}
	}
}

// An unchanged branch costs one ls-refs and no fetch; within fetchTtl it
// costs nothing.
func TestCLIResolve_UnchangedBranchFetchesNothing(t *testing.T) {
	srv, _, _ := chartFixture(t)
	src := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	ops := countGitOps(t)
	first := mustResolve(t, src)
	before := ops.snapshot()

	again := mustResolve(t, src)
	after := ops.snapshot()
	if again.Hash != first.Hash || again.LocalPath != first.LocalPath {
		t.Fatalf("second resolve = %+v, want %+v", again, first)
	}
	if after.lsRemote != before.lsRemote+1 || after.fetchCommit != before.fetchCommit || after.fetchBlob != before.fetchBlob {
		t.Fatalf("second resolve started %+v after %+v; want one more ls-remote and no fetch", after, before)
	}

	src.FetchTTL = time.Hour
	mustResolve(t, src)
	if ttl := ops.snapshot(); ttl != after {
		t.Fatalf("resolve within fetchTtl asked the remote: %+v after %+v", ttl, after)
	}
}

// A push fetches the new commit's changed trees and only the blob it changed;
// the earlier checkout is left as it was for any render still reading it.
func TestCLIResolve_PushFetchesOnlyWhatChanged(t *testing.T) {
	srv, work, _ := chartFixture(t)
	src := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	ops := countGitOps(t)
	first := mustResolve(t, src)
	writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: 3\n")
	randomFile(t, work, "releases/app-e.bin", 512<<10)
	tip := pushAll(t, work, "bump")
	before, beforeOps := srv.counts(), ops.snapshot()

	res := mustResolve(t, src)

	c, o := srv.counts(), ops.snapshot()
	if res.Revision != tip || res.LocalPath == first.LocalPath {
		t.Fatalf("resolve after push = %+v", res)
	}
	if o.fetchCommit != beforeOps.fetchCommit+1 || o.fetchBlob != beforeOps.fetchBlob+1 || c.blobWants != before.blobWants+1 {
		t.Fatalf("push started %+v after %+v and wanted %d blobs; want one commit fetch and one blob", o, beforeOps, c.blobWants-before.blobWants)
	}
	if sent := c.sent - before.sent; sent > 32<<10 {
		t.Fatalf("push sent %d bytes; a 512 KiB binary was pushed beside the chart", sent)
	}
	if old, err := os.ReadFile(filepath.Join(first.LocalPath, "values.yaml")); err != nil || string(old) != "replicas: 1\n" {
		t.Fatalf("earlier checkout changed: %q, %v", old, err)
	}
}

// A commit far below the mirror's tip (a drift render of an old release) is
// fetched alone at depth 1: its trees and the chart blobs it lacks, never its
// history or its binaries.
func TestCLIResolve_ArbitraryOldCommitFetchesOnlyThatCommit(t *testing.T) {
	srv, work, _ := chartFixture(t)
	commits := make([]string, 0, 4)
	for i := range 4 {
		writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: "+string(rune('2'+i))+"\n")
		randomFile(t, work, "releases/app-a.bin", 512<<10)
		commits = append(commits, pushAll(t, work, "release"))
	}
	workDir := t.TempDir()
	ops := countGitOps(t)
	mustResolve(t, cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir))
	before, beforeOps := srv.counts(), ops.snapshot()

	old := cliSource(srv.repoURL("origin.git"), commits[0], "deploy/chart", workDir)
	res := mustResolve(t, old)

	c, o := srv.counts(), ops.snapshot()
	if res.Revision != commits[0] {
		t.Fatalf("revision = %s, want %s", res.Revision, commits[0])
	}
	if o.lsRemote != beforeOps.lsRemote || o.fetchCommit != beforeOps.fetchCommit+1 || o.fetchBlob != beforeOps.fetchBlob+1 || c.blobWants != before.blobWants+1 {
		t.Fatalf("old commit started %+v after %+v and wanted %d blobs; want no ls-remote, one commit fetch and one blob",
			o, beforeOps, c.blobWants-before.blobWants)
	}
	if sent := c.sent - before.sent; sent > 32<<10 {
		t.Fatalf("old commit sent %d bytes; its history holds 2 MiB of binaries", sent)
	}
	parent := gitOutput(t, work, "rev-parse", commits[0]+"^")
	if hasObjectIn(cliMirrorDir(old), parent) {
		t.Fatalf("mirror fetched the old commit's parent %s: the fetch was not depth 1", parent)
	}
	got, err := os.ReadFile(filepath.Join(res.LocalPath, "values.yaml"))
	if err != nil || string(got) != "replicas: 2\n" {
		t.Fatalf("old values.yaml = %q, %v", got, err)
	}
	// Commits are immutable: the pinned commit never asks the remote again.
	mustResolve(t, old)
	if again := ops.snapshot(); again != o {
		t.Fatalf("pinned resolve asked the remote again: %+v after %+v", again, o)
	}
}

func hasObjectIn(mirror, oid string) bool {
	_, err := execGit(context.Background(), gitRun{dir: mirror, args: []string{"cat-file", "-e", oid}})
	return err == nil
}

// N concurrent resolves of one source with a fetchTtl share one ls-remote, one
// commit fetch and one blob fetch.
func TestCLIResolve_ConcurrentResolvesShareOneFetch(t *testing.T) {
	srv, _, tip := chartFixture(t)
	srv.lsRefsDelay = 200 * time.Millisecond
	ops := countGitOps(t)
	workDir := t.TempDir()
	const n = 8
	results := make([]*ResolveResult, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			src := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir)
			src.FetchTTL = 45 * time.Second
			results[i], errs[i] = src.Resolve(ctx)
			results[i].Release()
		})
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("resolve %d: %v", i, errs[i])
		}
		if results[i].Revision != tip || results[i].Hash != results[0].Hash || results[i].LocalPath != results[0].LocalPath {
			t.Fatalf("resolve %d = %+v, want %+v", i, results[i], results[0])
		}
	}
	if o := ops.snapshot(); o.lsRemote != 1 || o.fetchCommit != 1 || o.fetchBlob != 1 {
		t.Fatalf("%d concurrent resolves started %+v; want one ls-remote, one commit fetch, one blob fetch", n, o)
	}
}

// A request that gives up does not cancel the fetch it started: the fetch
// completes for the next request, which fetches nothing.
func TestCLIResolve_RequestGivingUpLeavesItsFetchToFinish(t *testing.T) {
	srv, _, tip := chartFixture(t)
	srv.hold = make(chan struct{})
	ops := countGitOps(t)
	workDir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	resolved := make(chan error, 1)
	go func() {
		_, err := cliSource(srv.repoURL("origin.git"), tip, "deploy/chart", workDir).Resolve(ctx)
		resolved <- err
	}()
	waitHeld(t, srv) // the fetch reached the server and is waiting
	cancel()         // the request gives up
	select {
	case err := <-resolved:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("resolve = %v, want the request's cancellation", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a cancelled request waited for its fetch")
	}
	close(srv.hold)

	res := mustResolve(t, cliSource(srv.repoURL("origin.git"), tip, "deploy/chart", workDir))
	if res.Revision != tip {
		t.Fatalf("revision = %s, want %s", res.Revision, tip)
	}
	if o := ops.snapshot(); o.fetchCommit != 1 {
		t.Fatalf("started %d commit fetches, want the one the first request started", o.fetchCommit)
	}
}

// A repository whose fetch hangs holds one fetch slot and its own lock, never
// another repository's.
func TestCLIResolve_SlowRepositoryDoesNotBlockAnother(t *testing.T) {
	requireGitCLI(t)
	withGitSettings(t, func(s *gitSettings) { s.maxFetches = 2 })
	srvRoot := t.TempDir()
	slow, fast := newCLITestServer(t, srvRoot), newCLITestServer(t, srvRoot)
	_, slowWork := newServedOrigin(t, srvRoot, "slow.git")
	_, fastWork := newServedOrigin(t, srvRoot, "fast.git")
	for _, w := range []string{slowWork, fastWork} {
		writeRepoFile(t, w, "chart/Chart.yaml", "name: x\n")
		pushAll(t, w, "chart")
	}
	slow.hold = make(chan struct{})
	workDir := t.TempDir()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, _ = cliSource(slow.repoURL("slow.git"), "main", "chart", workDir).Resolve(ctx) // held until cleanup
	}()
	// Registered last, so it runs before workDir is removed.
	t.Cleanup(func() { close(slow.hold); <-done })
	waitHeld(t, slow)

	start := time.Now()
	mustResolve(t, cliSource(fast.repoURL("fast.git"), "main", "chart", workDir))
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("fast repository took %s behind a hung one", elapsed)
	}
}

// waitHeld waits for a fetch to reach srv's hold, failing the test rather than
// waiting for go test's timeout.
func waitHeld(t *testing.T, srv *cliTestServer) {
	t.Helper()
	select {
	case <-srv.held:
	case <-time.After(30 * time.Second):
		t.Fatal("no fetch reached the server in 30s")
	}
}

// A request with fetchTtl 0 (a sync trigger) never takes an ls-remote answer
// from before it arrived, however recent.
func TestCLIResolve_FetchTTLZeroReusesNoEarlierAnswer(t *testing.T) {
	srv, work, _ := chartFixture(t)
	ops := countGitOps(t)
	src := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	mustResolve(t, src).Release()
	writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: 2\n")
	next := pushAll(t, work, "bump")
	res := mustResolve(t, src)
	res.Release()
	if res.Revision != next {
		t.Fatalf("resolve right after a push = %s, want the push %s", res.Revision, next)
	}
	if o := ops.snapshot(); o.lsRemote != 2 {
		t.Fatalf("started %d ls-remotes, want one per fetchTtl-0 resolve", o.lsRemote)
	}
}

// The cache on disk serves a restarted process: a pinned commit asks the
// remote nothing, a branch one ls-refs.
func TestCLIResolve_CacheOnDiskSurvivesARestart(t *testing.T) {
	srv, _, tip := chartFixture(t)
	workDir := t.TempDir()
	ops := countGitOps(t)
	first := mustResolve(t, cliSource(srv.repoURL("origin.git"), tip, "deploy/chart", workDir))
	before := ops.snapshot()

	forgetCLIState()
	pinned := mustResolve(t, cliSource(srv.repoURL("origin.git"), tip, "deploy/chart", workDir))
	if pinned.Hash != first.Hash || pinned.LocalPath != first.LocalPath {
		t.Fatalf("after restart = %+v, want %+v", pinned, first)
	}
	if o := ops.snapshot(); o != before {
		t.Fatalf("pinned resolve after restart started %+v after %+v", o, before)
	}

	forgetCLIState()
	mustResolve(t, cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir))
	if o := ops.snapshot(); o.lsRemote != before.lsRemote+1 || o.fetchCommit != before.fetchCommit || o.fetchBlob != before.fetchBlob {
		t.Fatalf("branch resolve after restart started %+v after %+v; want one ls-remote and no fetch", o, before)
	}
}

// Credentials reach the server through the credential helper, never git's
// argv or the mirror's config, and wrong ones fail without touching the
// cache.
func TestCLIResolve_AuthenticatedRepository(t *testing.T) {
	srv, _, tip := chartFixture(t)
	srv.user, srv.pass = "paprika", "s3cret-token-value"
	var mu sync.Mutex
	var argv []string
	gitProcessStarted = func(args []string, _ int) {
		mu.Lock()
		argv = append(argv, args...)
		mu.Unlock()
	}
	t.Cleanup(func() { gitProcessStarted = nil })

	bad := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	bad.Auth = GitAuth{Username: "paprika", Password: "wrong"}
	if _, err := bad.Resolve(context.Background()); err == nil {
		t.Fatal("resolve with a wrong password succeeded")
	}

	good := cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", t.TempDir())
	good.Auth = GitAuth{Username: "paprika", Password: "s3cret-token-value"}
	if res := mustResolve(t, good); res.Revision != tip {
		t.Fatalf("revision = %s, want %s", res.Revision, tip)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(strings.Join(argv, " "), "s3cret") {
		t.Fatal("the password reached git's argv")
	}
	config, err := os.ReadFile(filepath.Join(cliMirrorDir(good), "config"))
	if err != nil || strings.Contains(string(config), "s3cret") {
		t.Fatalf("mirror config holds the password or is unreadable: %v", err)
	}
}

// A path that is missing or not a directory is the source's error, and a
// symlink out of the source path is refused.
func TestCLIResolve_RejectsBadPathsAndEscapingSymlinks(t *testing.T) {
	srv, work, _ := chartFixture(t)
	url := srv.repoURL("origin.git")
	for _, path := range []string{"deploy/missing", "deploy/chart/values.yaml"} {
		_, err := cliSource(url, "main", path, t.TempDir()).Resolve(context.Background())
		if err == nil || !strings.Contains(err.Error(), "is not a directory") {
			t.Fatalf("path %q: err = %v", path, err)
		}
	}
	if _, err := cliSource(url, "main", "../etc", t.TempDir()).Resolve(context.Background()); err == nil {
		t.Fatal("a path leaving the repository resolved")
	}
	if err := os.Symlink("../../../../etc/hostname", filepath.Join(work, "deploy/chart/templates/leak.yaml")); err != nil {
		t.Fatal(err)
	}
	pushAll(t, work, "leak")
	_, err := cliSource(url, "main", "deploy/chart", t.TempDir()).Resolve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "points outside the source path") {
		t.Fatalf("escaping symlink: err = %v", err)
	}
}

// A mirror whose packs were truncated (a node crash mid-write) is rebuilt by
// the resolve that cannot read it, which then succeeds.
func TestCLIResolve_BrokenMirrorIsRebuilt(t *testing.T) {
	srv, _, tip := chartFixture(t)
	workDir := t.TempDir()
	mustResolve(t, cliSource(srv.repoURL("origin.git"), tip, "deploy/chart", workDir))
	mirror := cliMirrorDir(cliSource(srv.repoURL("origin.git"), tip, "", workDir))
	packs, err := filepath.Glob(filepath.Join(mirror, "objects", "pack", "*.pack"))
	if err != nil || len(packs) == 0 {
		t.Fatalf("no packs in the mirror: %v", err)
	}
	for _, p := range packs {
		info, statErr := os.Stat(p)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if err := os.Chmod(p, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(p, info.Size()/2); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := markMirror(t, mirror)
	forgetCLIState()

	// Another path of the same commit reads the broken packs.
	res := mustResolve(t, cliSource(srv.repoURL("origin.git"), tip, "deploy", workDir))

	if res.Revision != tip {
		t.Fatalf("revision = %s, want %s", res.Revision, tip)
	}
	if !mirrorWasReset(sentinel) {
		t.Fatal("the broken mirror was not rebuilt")
	}
	if got := checkedOutFiles(t, res.LocalPath); len(got) != 3 {
		t.Fatalf("checked out %v, want the chart's 3 files", got)
	}
}

// Eviction removes the least recently used entries until the cache fits,
// never one used within the minimum age.
func TestEvictCache_RemovesLeastRecentlyUsedFirst(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "checkouts", "repo")
	mk := func(name string, age time.Duration) string {
		base := filepath.Join(dir, name)
		writeRepoFile(t, base, "chart/big", strings.Repeat("x", 1000))
		writeRepoFile(t, dir, name+checkoutMarkerSuffix, `{"dirHash":"0123456789abcdef0123"}`)
		when := time.Now().Add(-age)
		if err := os.Chtimes(base+checkoutMarkerSuffix, when, when); err != nil {
			t.Fatal(err)
		}
		return base
	}
	oldest, older, recent := mk("a", 3*time.Hour), mk("b", 2*time.Hour), mk("c", time.Minute)

	left := evictCache(context.Background(), root, 1500, 10*time.Minute)

	if _, err := os.Stat(oldest); !os.IsNotExist(err) {
		t.Fatal("the least recently used checkout survived")
	}
	if _, err := os.Stat(older); !os.IsNotExist(err) {
		t.Fatal("the cache is still over its bound with an evictable checkout left")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("a checkout used within the minimum age was evicted: %v", err)
	}
	if left <= 0 || left > 1500 {
		t.Fatalf("left %d bytes, want the recent checkout's", left)
	}
}

// Auto picks the CLI only for transports it serves.
func TestGitSourceBackend(t *testing.T) {
	requireGitCLI(t)
	for _, tc := range []struct {
		url     string
		backend GitBackend
		want    GitBackend
	}{
		{"https://github.com/a/b", GitBackendAuto, GitBackendCLI},
		{"http://git.example/a.git", "", GitBackendGoGit}, // TestMain's default
		{"/srv/git/a.git", GitBackendAuto, GitBackendCLI},
		{"file:///srv/git/a.git", GitBackendCLI, GitBackendCLI},
		{"git@github.com:a/b.git", GitBackendAuto, GitBackendGoGit},
		{"ssh://git@github.com/a/b.git", GitBackendCLI, GitBackendGoGit},
		{"https://github.com/a/b", GitBackendGoGit, GitBackendGoGit},
	} {
		if got := (&GitSource{RepoURL: tc.url, Backend: tc.backend}).backend(); got != tc.want {
			t.Errorf("backend(%s, %q) = %s, want %s", tc.url, tc.backend, got, tc.want)
		}
	}
}

func TestGitSettingsFromEnv(t *testing.T) {
	env := map[string]string{
		EnvGitBackend:              "CLI",
		EnvGitMaxConcurrentFetches: "6",
		EnvGitFetchTimeout:         "3m",
		EnvGitCacheMaxBytes:        "20Gi",
		EnvGitCacheMinAge:          "5m",
	}
	s, err := gitSettingsFromEnv(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if s.backend != GitBackendCLI || s.maxFetches != 6 || s.fetchTimeout != 3*time.Minute ||
		s.cacheMaxBytes != 20<<30 || s.cacheMinAge != 5*time.Minute {
		t.Fatalf("settings = %+v", s)
	}
	bad := map[string]string{EnvGitBackend: "libgit2", EnvGitMaxConcurrentFetches: "0", EnvGitCacheMaxBytes: "lots"}
	s, err = gitSettingsFromEnv(func(k string) string { return bad[k] })
	if err == nil {
		t.Fatal("invalid settings were accepted")
	}
	if d := defaultGitSettings(); s.backend != d.backend || s.maxFetches != d.maxFetches || s.cacheMaxBytes != 0 {
		t.Fatalf("invalid settings did not keep the defaults: %+v", s)
	}
}

func TestValidateRevisionAndPath(t *testing.T) {
	for _, rev := range []string{"--upload-pack=touch /tmp/x", "main..dev", "a b", "v1^{}", "x:y"} {
		if validateRevision(rev) == nil {
			t.Errorf("revision %q accepted", rev)
		}
	}
	for _, rev := range []string{"", "main", "release/1.2", "refs/tags/v0.3.0", strings.Repeat("a", 40)} {
		if err := validateRevision(rev); err != nil {
			t.Errorf("revision %q rejected: %v", rev, err)
		}
	}
	for in, want := range map[string]string{"": "", "./charts/x/": "charts/x", "deploy//chart": "deploy/chart", "/a/b": "a/b"} {
		if got, err := cleanSourcePath(in); err != nil || got != want {
			t.Errorf("cleanSourcePath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, p := range []string{"..", "../x", "a/../../b", "a\nb"} {
		if _, err := cleanSourcePath(p); err == nil {
			t.Errorf("path %q accepted", p)
		}
	}
}
