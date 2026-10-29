package source

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// Outside tests a resolve fetches only http(s): a file:// URL or a local path
// would read another repository cached on the repo server, or any directory
// it can read. Both backends refuse one, and git is not allowed the file
// transport.
func TestGitSourceResolve_RefusesLocalRepositoriesOutsideTests(t *testing.T) {
	requireGitCLI(t)
	_, origin, work := newOrigin(t)
	writeRepoFile(t, work, "chart/Chart.yaml", "name: x\n")
	commitAll(t, work, "chart")
	runGit(t, work, "push", "--quiet", "origin", "main")
	allowLocalGitRepos = false
	t.Cleanup(func() { allowLocalGitRepos = true })

	for _, backend := range []GitBackend{GitBackendCLI, GitBackendGoGit, GitBackendAuto} {
		for _, url := range []string{origin, "file://" + origin, "git@github.com:org/repo.git"} {
			src := &GitSource{RepoURL: url, Revision: "main", Path: "chart", WorkDir: t.TempDir(), Backend: backend}
			_, err := src.Resolve(context.Background())
			if err == nil || !strings.Contains(err.Error(), "http:// or https://") {
				t.Errorf("%s %s: err = %v, want a refusal", backend, url, err)
			}
		}
	}
	if got := allowedGitProtocols(); got != "https:http" {
		t.Errorf("GIT_ALLOW_PROTOCOL = %q, want https:http", got)
	}
	if cliServesURL("file://" + origin) {
		t.Error("the CLI backend serves file:// outside tests")
	}
}

// The credential helper answers only the repository's own protocol and host:
// not another host after a redirect, and not http:// on the same host.
func TestCredentialHelperAnswersOnlyTheRepositorysOrigin(t *testing.T) {
	requireGitCLI(t)
	cred := &gitCred{protocol: "https", host: "github.com", username: "x-access-token", password: "s3cret"}
	for _, tc := range []struct {
		input string
		want  bool
	}{
		{"protocol=https\nhost=github.com\n", true},
		{"protocol=http\nhost=github.com\n", false},
		{"protocol=https\nhost=evil.example\n", false},
		{"protocol=https\nhost=github.com.evil.example\n", false},
	} {
		cmd := exec.CommandContext(context.Background(), "git", "credential", "fill")
		cmd.Env = gitEnv("", cred)
		cmd.Stdin = strings.NewReader(tc.input + "\n")
		out, _ := cmd.Output() // fill fails when no helper answers and prompts are off
		if got := strings.Contains(string(out), "password=s3cret"); got != tc.want {
			t.Errorf("%q: answered %v, want %v (output %q)", tc.input, got, tc.want, out)
		}
	}
}

// symlinkFixture pushes a chart holding the symlink chart/name -> link (and,
// for links through another link, extra), and a file outside the chart.
func symlinkFixture(t *testing.T, links map[string]string) (cliURL, localOrigin string) {
	t.Helper()
	srv, work, _ := chartFixture(t)
	writeRepoFile(t, work, "deploy/secret.txt", "outside the chart\n")
	for name, link := range links {
		if err := os.Symlink(link, filepath.Join(work, "deploy/chart", name)); err != nil {
			t.Fatal(err)
		}
	}
	pushAll(t, work, "links")
	return srv.repoURL("origin.git"), filepath.Join(srv.root, "origin.git")
}

// A symlink that leaves the source path is refused by both backends, whether
// it is absolute, climbs out lexically, or climbs out through another link
// that looks harmless on its own ("s" -> "." makes "s/../secret.txt" climb
// out of the chart).
func TestResolve_RefusesSymlinksOutOfTheSourcePath(t *testing.T) {
	for name, links := range map[string]map[string]string{
		"absolute":     {"leak.yaml": "/etc/hosts"},
		"climbs out":   {"leak.yaml": "../secret.txt"},
		"through link": {"s": ".", "leak.yaml": "s/../secret.txt"},
	} {
		t.Run(name, func(t *testing.T) {
			cliURL, localOrigin := symlinkFixture(t, links)
			for _, src := range []*GitSource{
				cliSource(cliURL, "main", "deploy/chart", t.TempDir()),
				{RepoURL: localOrigin, Revision: "main", Path: "deploy/chart", WorkDir: t.TempDir(), Shallow: true, Backend: GitBackendGoGit},
			} {
				_, err := src.Resolve(context.Background())
				if err == nil || !strings.Contains(err.Error(), "symlink") {
					t.Errorf("%s backend: err = %v, want the symlink refused", src.Backend, err)
				}
			}
		})
	}
}

// A symlink that stays inside the source path is checked out by both.
func TestResolve_KeepsSymlinksInsideTheSourcePath(t *testing.T) {
	cliURL, localOrigin := symlinkFixture(t, map[string]string{"link.yaml": "values.yaml"})
	for _, src := range []*GitSource{
		cliSource(cliURL, "main", "deploy/chart", t.TempDir()),
		{RepoURL: localOrigin, Revision: "main", Path: "deploy/chart", WorkDir: t.TempDir(), Shallow: true, Backend: GitBackendGoGit},
	} {
		res := mustResolve(t, src)
		if target, err := os.Readlink(filepath.Join(res.LocalPath, "link.yaml")); err != nil || target != "values.yaml" {
			t.Errorf("%s backend: link.yaml -> %q, %v", src.Backend, target, err)
		}
		res.Release()
	}
}

// No entry is written beneath a symlinked directory: on a case-insensitive
// filesystem a link "A" and a file "a/x" of one tree alias.
func TestCheckoutGuard_RefusesEntriesBeneathASymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "A")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "real", "dir"), 0o750); err != nil {
		t.Fatal(err)
	}
	g := newCheckoutGuard(root)
	if err := g.parentsOK("A/x.yaml"); err == nil || !strings.Contains(err.Error(), "beneath the symlink") {
		t.Fatalf("entry beneath a symlink: err = %v", err)
	}
	for _, ok := range []string{"top.yaml", "real/dir/x.yaml", "new/dir/x.yaml"} {
		if err := g.parentsOK(ok); err != nil {
			t.Fatalf("%s: %v", ok, err)
		}
	}
	if _, err := createFile(filepath.Join(root, "A"), 0o640); err == nil {
		t.Fatal("a file was created through an existing symlink")
	}
}

// fsck checks every fetched object: a tree with a ".git" entry fails the
// fetch instead of reaching a checkout.
func TestCLIResolve_FsckRefusesAHostileTree(t *testing.T) {
	srv, work, _ := chartFixture(t)
	blob := strings.TrimSpace(gitOutput(t, work, "rev-parse", "HEAD:deploy/chart/values.yaml"))
	inner := strings.TrimSpace(runGitStdin(t, work, "100644 blob "+blob+"\tconfig\n", "mktree"))
	chart := strings.TrimSpace(gitOutput(t, work, "rev-parse", "HEAD:deploy/chart"))
	hostile := strings.TrimSpace(runGitStdin(t, work, "040000 tree "+chart+"\tchart\n040000 tree "+inner+"\t.git\n", "mktree"))
	root := strings.TrimSpace(runGitStdin(t, work, "040000 tree "+hostile+"\tdeploy\n", "mktree"))
	commit := strings.TrimSpace(gitOutput(t, work, "commit-tree", "-m", "hostile", root))
	runGit(t, work, "push", "--quiet", "--force", "origin", commit+":refs/heads/main")

	_, err := cliSource(srv.repoURL("origin.git"), commit, "deploy/chart", t.TempDir()).Resolve(context.Background())
	if err == nil || !strings.Contains(err.Error(), "fsck") {
		t.Fatalf("resolve of a tree with a .git entry: err = %v, want fsck to refuse it", err)
	}
}

func runGitStdin(t *testing.T, dir, stdin string, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", args...) // #nosec G204 -- test helper
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return string(out)
}

// A checkout leased by a resolve whose caller is still reading it is never
// evicted, however old; once released it is. One used since the scan is kept.
func TestEvictCache_SkipsLeasedAndRecentlyUsedCheckouts(t *testing.T) {
	srv, work, _ := chartFixture(t)
	workDir := t.TempDir()
	root := filepath.Join(workDir, gitCacheDirName)
	leased := mustResolve(t, cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir))
	writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: 9\n")
	pushAll(t, work, "bump")
	other := mustResolve(t, cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir))
	other.Release()
	ageMarkers(t, root, 3*time.Hour)

	evictCache(context.Background(), root, 1, time.Minute)

	if _, err := os.Stat(leased.LocalPath); err != nil {
		t.Fatalf("a leased checkout was evicted: %v", err)
	}
	if _, err := os.Stat(other.LocalPath); !os.IsNotExist(err) {
		t.Fatalf("an unleased old checkout survived: %v", err)
	}

	// Used since the scan: retireCheckout looks at the marker again.
	leased.Release()
	entries, _ := scanCache(context.Background(), root)
	touchCheckout(filepath.Dir(filepath.Dir(leased.LocalPath)))
	for i := range entries {
		if entries[i].kind == "checkout" && removeCacheEntry(&entries[i], time.Minute) {
			t.Fatalf("evicted %s, used since the scan", entries[i].path)
		}
	}

	ageMarkers(t, root, 3*time.Hour)
	evictCache(context.Background(), root, 1, time.Minute)
	if _, err := os.Stat(leased.LocalPath); !os.IsNotExist(err) {
		t.Fatalf("a released old checkout survived: %v", err)
	}
	// The next resolve writes it again.
	again := mustResolve(t, cliSource(srv.repoURL("origin.git"), "main", "deploy/chart", workDir))
	defer again.Release()
	if _, err := os.Stat(filepath.Join(again.LocalPath, "values.yaml")); err != nil {
		t.Fatalf("resolve after eviction: %v", err)
	}
}

// ageMarkers backdates every checkout marker and mirror stamp under root.
func ageMarkers(t *testing.T, root string, age time.Duration) {
	t.Helper()
	when := time.Now().Add(-age)
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasSuffix(p, checkoutMarkerSuffix) || d.Name() == mirrorUsedFile {
			return os.Chtimes(p, when, when) // #nosec G122 -- the test's own temp dir
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// The cache size gauge names the work dir it measures: the manager's
// fallback renderer has two.
func TestEvictCache_RecordsTheSizePerWorkDir(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	before := otel.GetMeterProvider()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))
	t.Cleanup(func() { otel.SetMeterProvider(before) })
	root := t.TempDir()
	writeRepoFile(t, root, "mirrors/x.git/objects/pack/p.pack", strings.Repeat("x", 100))

	evictCache(context.Background(), root, 0, 0)

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			gauge, ok := m.Data.(metricdata.Gauge[int64])
			if m.Name != "paprika.git.cache.size" || !ok {
				continue
			}
			for _, dp := range gauge.DataPoints {
				if v, _ := dp.Attributes.Value(attribute.Key("dir")); v.AsString() == root && dp.Value == 100 {
					return
				}
			}
		}
	}
	t.Fatalf("no paprika.git.cache.size point of 100 with dir=%s in %+v", root, rm)
}

// A rebuild waits for the mirror's other users no longer than its request
// allows, and while it waits other resolves still read the mirror.
func TestCLIRepoReset_GivesUpAtItsDeadlineWithoutBlockingReaders(t *testing.T) {
	repo := cliRepoFor(filepath.Join(t.TempDir(), "m.git"), "https://example.invalid/r")
	repo.life.RLock() // a fetch in flight
	defer repo.life.RUnlock()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	readerDone := make(chan struct{})
	resetDone := make(chan error, 1)
	go func() { resetDone <- repo.reset(ctx) }()
	go func() {
		time.Sleep(50 * time.Millisecond)
		repo.life.RLock() // another resolve, while the rebuild waits
		repo.life.RUnlock()
		close(readerDone)
	}()
	select {
	case <-readerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("a waiting rebuild blocked another reader of the mirror")
	}
	select {
	case err := <-resetDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("reset = %v, want its deadline", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reset outlived its deadline")
	}
}

// A server that serves only refs (protocol v0 without allowAnySHA1InWant)
// refuses commits and blobs by ID. A branch then fetches its ref unfiltered
// at depth 1, and a pinned commit every branch's history.
func TestCLIResolve_ServerRefusingObjectsByID(t *testing.T) {
	srv, work, _ := chartFixture(t)
	origin := filepath.Join(srv.root, "origin.git")
	runGit(t, origin, "config", "uploadpack.allowAnySHA1InWant", "false")
	srv.v0 = true
	old := strings.TrimSpace(gitOutput(t, work, "rev-parse", "HEAD"))
	writeRepoFile(t, work, "deploy/chart/values.yaml", "replicas: 4\n")
	tip := pushAll(t, work, "bump")

	for _, tc := range []struct{ rev, want, values string }{
		{"main", tip, "replicas: 4\n"},
		{old, old, "replicas: 1\n"},
	} {
		src := cliSource(srv.repoURL("origin.git"), tc.rev, "deploy/chart", t.TempDir())
		res := mustResolve(t, src)
		got, err := os.ReadFile(filepath.Join(res.LocalPath, "values.yaml"))
		if res.Revision != tc.want || err != nil || string(got) != tc.values {
			t.Fatalf("%s: revision %s, values %q, %v", tc.rev, res.Revision, got, err)
		}
		res.Release()
	}
}

// Without a usable git, auto resolves with go-git; an explicit cli fails
// rather than falling back silently.
func TestGitSourceBackend_AutoWithoutGitUsesGoGit(t *testing.T) {
	_, origin, work := newOrigin(t)
	writeRepoFile(t, work, "chart/Chart.yaml", "name: x\n")
	commitAll(t, work, "chart")
	runGit(t, work, "push", "--quiet", "origin", "main")
	withGitBinary(t, "paprika-test-no-such-git")

	auto := &GitSource{RepoURL: origin, Revision: "main", Path: "chart", WorkDir: t.TempDir(), Shallow: true, Backend: GitBackendAuto}
	if b := auto.backend(); b != GitBackendGoGit {
		t.Fatalf("auto without git = %s, want go-git", b)
	}
	res := mustResolve(t, auto)
	if _, err := os.Stat(filepath.Join(auto.WorkDir, "git-mirrors")); err != nil {
		t.Fatalf("auto without git did not resolve with go-git: %v", err)
	}
	res.Release()

	cli := cliSource(origin, "main", "chart", t.TempDir())
	if _, err := cli.Resolve(context.Background()); err == nil || !strings.Contains(err.Error(), "git CLI backend") {
		t.Fatalf("cli without git: err = %v", err)
	}
}

// Releasing a result twice, or a nil one, is harmless.
func TestResolveResult_ReleaseIsIdempotent(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	release := leaseCheckout("/nonexistent/base")
	r := &ResolveResult{release: func() { mu.Lock(); calls++; mu.Unlock(); release() }}
	r.Release()
	release()
	var nilResult *ResolveResult
	nilResult.Release()
	checkoutLeases.Lock()
	n := checkoutLeases.n["/nonexistent/base"]
	checkoutLeases.Unlock()
	if n != 0 || calls != 1 {
		t.Fatalf("lease count %d after release, wrapper called %d times", n, calls)
	}
}

// checkSymlinkTarget refuses, before anything is written, a link that is
// empty, absolute, or leaves the root lexically. An absolute link is refused
// even when it would resolve inside the checkout: its meaning depends on where
// the checkout sits.
func TestCheckSymlinkTarget(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct{ name, link string }{
		{"templates/link.yaml", ""},
		{"templates/link.yaml", "/etc/hosts"},
		{"templates/link.yaml", filepath.Join(root, "values.yaml")},
		{"templates/link.yaml", "../.."},
		{"templates/link.yaml", "a/../../../x"},
		{"link.yaml", ".."},
		{"link.yaml", "../x"},
	} {
		if err := checkSymlinkTarget(tc.name, tc.link); err == nil {
			t.Errorf("%s -> %q accepted", tc.name, tc.link)
		}
	}
	for _, link := range []string{"values.yaml", "../values.yaml", "..", "sub/../values.yaml"} {
		if err := checkSymlinkTarget("templates/link.yaml", link); err != nil {
			t.Errorf("templates/link.yaml -> %q refused: %v", link, err)
		}
	}
}
