package source

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"golang.org/x/sync/singleflight"
	"sigs.k8s.io/controller-runtime/pkg/log"

	"github.com/go-git/go-git/v5/plumbing/transport/http"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// The CLI backend keeps, under <WorkDir>/git-cache:
//
//	mirrors/<repo key>.git           a bare blobless partial clone, one per
//	                                 repository and credential
//	checkouts/<repo key>/<tree>-<p>  the files under one source path at one
//	                                 tree, laid out at <p>'s path; immutable
//	checkouts/<repo key>/<...>.done  the marker that a checkout is complete,
//	                                 holding its directory hash
//
// A resolve asks the remote which commit the revision names (ls-remote), then
// fetches that commit at depth 1 with --filter=blob:none (the commit and its
// trees, about 1 MB for brandbrain's 22,795-file tip), then fetches in one
// request only the blobs under the source path that the mirror lacks, and
// writes them out. A checkout is keyed by its tree, so a commit that did not
// touch the path reuses the files already written, and nothing a render is
// reading is ever rewritten in place.
const gitCacheDirName = "git-cache"

// maxMirrorRefs bounds the commit refs one mirror keeps. Older commits'
// trees become unreachable and gc prunes them; a commit needed again is
// fetched again, at the cost of one commit's trees.
const maxMirrorRefs = 64

// lsRemoteJoinWindow lets a request with fetchTtl 0 share an ls-remote of
// the same revision that began at most this long before it arrived.
const lsRemoteJoinWindow = time.Second

// commitRefPrefix holds one ref per commit the mirror has fetched.
const commitRefPrefix = "refs/paprika/c/"

// cliRepo is the in-process state of one mirror.
type cliRepo struct {
	dir string
	url string
	// life is held for reading by everything that uses the mirror and for
	// writing by whatever removes it (corruption recovery, eviction). Never
	// hold it while waiting for a flight: the flight takes it too.
	life sync.RWMutex
	// fetchSlot serializes the commands that write the mirror.
	fetchSlot chan struct{}
	inited    atomic.Bool
	initMu    sync.Mutex
	revisions revisionCache
	commits   singleflight.Group
}

var cliRepos = struct {
	sync.Mutex
	m map[string]*cliRepo
}{m: map[string]*cliRepo{}}

// cliRepoFor returns the state of the mirror at dir.
func cliRepoFor(dir, repoURL string) *cliRepo {
	cliRepos.Lock()
	defer cliRepos.Unlock()
	r := cliRepos.m[dir]
	if r == nil {
		r = &cliRepo{dir: dir, url: repoURL, fetchSlot: make(chan struct{}, 1)}
		cliRepos.m[dir] = r
	}
	if r.url == "" {
		r.url = repoURL
	}
	return r
}

// checkoutFlights shares one materialization of a checkout among the
// requests that want it.
var checkoutFlights singleflight.Group

// lazyCred mints the source's credential on first use, so a resolve answered
// from the cache mints no GitHub App token.
type lazyCred struct {
	src  *GitSource
	mu   sync.Mutex
	done bool
	cred *gitCred
}

func (l *lazyCred) get(ctx context.Context) (*gitCred, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done {
		return l.cred, nil
	}
	am, err := l.src.authMethod(ctx)
	if err != nil {
		return nil, err
	}
	if basic, ok := am.(*http.BasicAuth); ok && basic != nil {
		u, parseErr := url.Parse(l.src.RepoURL)
		if parseErr != nil {
			return nil, fmt.Errorf("parse repository URL: %w", parseErr)
		}
		l.cred = &gitCred{host: u.Host, username: basic.Username, password: basic.Password}
	}
	l.done = true
	return l.cred, nil
}

// resolveCLI resolves the source with the git CLI backend.
func (g *GitSource) resolveCLI(ctx context.Context) (*ResolveResult, error) {
	if _, err := gitCLI(); err != nil {
		return nil, err
	}
	srcPath, err := cleanSourcePath(g.Path)
	if err != nil {
		return nil, err
	}
	if revErr := validateRevision(g.Revision); revErr != nil {
		return nil, revErr
	}
	key := RepoCacheKey(g.RepoURL, g.credentialID())
	root := filepath.Join(g.WorkDir, gitCacheDirName)
	repo := cliRepoFor(filepath.Join(root, "mirrors", key+".git"), g.RepoURL)
	creds := &lazyCred{src: g}
	defer scheduleCacheEviction(ctx, root)

	result, err := g.resolveCLIOnce(ctx, repo, filepath.Join(root, "checkouts", key), srcPath, creds)
	var local *localGitError
	if err == nil || !errors.As(err, &local) {
		return result, err
	}
	// The mirror could not be read. It costs one commit's trees to rebuild.
	if resetErr := repo.reset(); resetErr != nil {
		return nil, errors.Join(err, resetErr)
	}
	return g.resolveCLIOnce(ctx, repo, filepath.Join(root, "checkouts", key), srcPath, creds)
}

func (g *GitSource) resolveCLIOnce(ctx context.Context, repo *cliRepo, checkoutDir, srcPath string, creds *lazyCred) (*ResolveResult, error) {
	if err := repo.ensureInit(ctx); err != nil {
		return nil, err
	}
	rev := strings.TrimSpace(g.Revision)
	sha, ref, err := g.cliRevision(ctx, repo, rev, creds)
	if err != nil {
		return nil, err
	}
	if fetchErr := repo.ensureCommit(ctx, sha, ref, g.cliDepth(), creds); fetchErr != nil {
		if ref != "" {
			repo.revisions.forget(rev)
		}
		return nil, fetchErr
	}
	tree, err := repo.pathTree(ctx, sha, srcPath)
	if err != nil {
		return nil, err
	}
	co, err := ensureCheckout(ctx, repo, checkoutDir, tree, srcPath, creds)
	if err != nil {
		return nil, err
	}
	repo.touch()
	return &ResolveResult{
		LocalPath: co.localPath,
		Hash:      sha[:16] + ":" + co.dirHash[:16],
		Revision:  sha,
	}, nil
}

// cliDepth is the depth of a commit fetch: 1, the commit and its trees,
// unless the source asks for more. Shallow and FetchAllRefs worked around the
// go-git mirror's growth and do not apply: rendering reads one commit's tree.
func (g *GitSource) cliDepth() int {
	if g.Depth > 0 {
		return g.Depth
	}
	return 1
}

// cleanSourcePath normalises a source path ("./charts/x/" is "charts/x") and
// rejects one that leaves the repository.
func cleanSourcePath(p string) (string, error) {
	if strings.ContainsAny(p, "\x00\n\r\\") {
		return "", fmt.Errorf("checkout tree: path %q is not a valid repository path", p)
	}
	for _, name := range strings.Split(strings.TrimSpace(p), "/") {
		if name == ".." {
			return "", fmt.Errorf("checkout tree: path %q leaves the repository", p)
		}
	}
	return path.Clean("/" + strings.TrimSpace(p))[1:], nil
}

// validateRevision rejects a revision git could read as an option or that no
// ref can be named.
func validateRevision(rev string) error {
	rev = strings.TrimSpace(rev)
	if rev == "" || isHexSHA(rev) {
		return nil
	}
	if strings.HasPrefix(rev, "-") || strings.Contains(rev, "..") || strings.ContainsAny(rev, " ~^:?*[\\\x7f") {
		return fmt.Errorf("resolve revision %q: not a valid branch, tag or ref name", rev)
	}
	for _, c := range rev {
		if c < 0x20 {
			return fmt.Errorf("resolve revision %q: not a valid branch, tag or ref name", rev)
		}
	}
	return nil
}

// cliRevision returns the commit the revision names, and the ref that names
// it (empty for a pinned commit).
func (g *GitSource) cliRevision(ctx context.Context, repo *cliRepo, rev string, creds *lazyCred) (sha, ref string, err error) {
	if isHexSHA(rev) {
		return strings.ToLower(rev), "", nil
	}
	notBefore := time.Now().Add(-max(g.FetchTTL, lsRemoteJoinWindow))
	answer, result, err := repo.revisions.lookup(ctx, rev, notBefore, func() (string, string, error) {
		lsCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), currentGitSettings().lsRemoteTimeout)
		defer cancel()
		return repo.lsRemote(lsCtx, rev, creds)
	})
	paprikametrics.GitCacheLookups.Add(ctx, 1, metric.WithAttributes(
		attribute.String("layer", "revision"), attribute.String("result", string(result))))
	if errors.Is(err, errRevisionNotFound) {
		// A short commit hash names no ref; the mirror may hold it.
		if local, ok := repo.localCommit(ctx, rev); ok {
			return local, "", nil
		}
	}
	if err != nil {
		return "", "", err
	}
	return answer.sha, answer.ref, nil
}

var errRevisionNotFound = errors.New("not found as branch, tag, or commit")

// lsRemote asks the remote which commit rev names. Protocol v2 sends only the
// refs asked for, so this costs one round trip on a repository of any size.
func (r *cliRepo) lsRemote(ctx context.Context, rev string, creds *lazyCred) (sha, ref string, err error) {
	cred, err := creds.get(ctx)
	if err != nil {
		return "", "", err
	}
	release, err := acquireSlot(ctx, currentGitLimiter().lsRemotes)
	if err != nil {
		return "", "", err
	}
	defer release()
	args, wanted := lsRemoteArgs(rev)
	var out []byte
	err = observeGitNetwork(ctx, "ls-remote", func() error {
		var runErr error
		out, runErr = execGit(ctx, gitRun{dir: r.dir, args: args, cred: cred})
		return runErr
	})
	if err != nil {
		return "", "", fmt.Errorf("resolve revision %s of %s: %w", rev, redactURL(r.url), err)
	}
	refs := parseLsRemote(out)
	for _, name := range wanted {
		if peeled, ok := refs[name+"^{}"]; ok {
			return peeled, name, nil
		}
		if oid, ok := refs[name]; ok {
			return oid, name, nil
		}
	}
	return "", "", fmt.Errorf("resolve revision %s: %w", rev, errRevisionNotFound)
}

// lsRemoteArgs returns the ls-remote for rev and the refs that may answer it,
// best first: a branch before a tag of the same name, as the go-git backend
// resolves them.
func lsRemoteArgs(rev string) (args, wanted []string) {
	switch {
	case rev == "":
		return []string{"ls-remote", "--symref", "origin", "HEAD"}, []string{"HEAD"}
	case strings.HasPrefix(rev, "refs/"):
		return []string{"ls-remote", "origin", rev, rev + "^{}"}, []string{rev}
	default:
		heads, tags := "refs/heads/"+rev, "refs/tags/"+rev
		return []string{"ls-remote", "origin", heads, tags, tags + "^{}"}, []string{heads, tags}
	}
}

func parseLsRemote(out []byte) map[string]string {
	refs := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		sha, name, ok := strings.Cut(sc.Text(), "\t")
		if ok && isHexSHA(sha) {
			refs[name] = strings.ToLower(sha)
		}
	}
	return refs
}

// localCommit resolves a short commit hash from the mirror alone.
func (r *cliRepo) localCommit(ctx context.Context, rev string) (string, bool) {
	if len(rev) < 4 || len(rev) > 40 || strings.Trim(strings.ToLower(rev), "0123456789abcdef") != "" {
		return "", false
	}
	r.life.RLock()
	defer r.life.RUnlock()
	out, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"rev-parse", "--verify", "--quiet", rev + "^{commit}"}})
	sha := strings.TrimSpace(string(out))
	return sha, err == nil && isHexSHA(sha)
}

// observeGitNetwork times one git network operation.
func observeGitNetwork(ctx context.Context, op string, fn func() error) error {
	paprikametrics.GitFetchesInFlight.Add(ctx, 1, metric.WithAttributes(attribute.String("op", op)))
	start := time.Now()
	err := fn()
	paprikametrics.GitFetchesInFlight.Add(ctx, -1, metric.WithAttributes(attribute.String("op", op)))
	result := "ok"
	if err != nil {
		result = "error"
	}
	paprikametrics.GitFetchDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(
		attribute.String("op", op), attribute.String("result", result)))
	return err
}

// ensureInit creates the mirror on first use: a bare repository whose origin
// is a promisor remote filtering blobs. A directory without the layout marker
// (an interrupted init, an older layout) is replaced.
func (r *cliRepo) ensureInit(ctx context.Context) error {
	if r.inited.Load() {
		return nil
	}
	r.initMu.Lock()
	defer r.initMu.Unlock()
	r.life.RLock()
	defer r.life.RUnlock()
	if r.inited.Load() {
		return nil
	}
	if config, err := os.ReadFile(filepath.Join(r.dir, "config")); err == nil && strings.Contains(string(config), mirrorLayoutMarker) {
		r.inited.Store(true)
		return nil
	}
	if err := os.RemoveAll(r.dir); err != nil {
		return fmt.Errorf("init git mirror: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(r.dir), 0o750); err != nil {
		return fmt.Errorf("init git mirror: %w", err)
	}
	if _, err := execGit(ctx, gitRun{args: []string{"init", "--bare", "--quiet", "--template=", r.dir}}); err != nil {
		return fmt.Errorf("init git mirror: %w", err)
	}
	if err := os.WriteFile(filepath.Join(r.dir, "config"), []byte(mirrorConfig(r.url)), 0o600); err != nil {
		return fmt.Errorf("init git mirror: %w", err)
	}
	r.inited.Store(true)
	return nil
}

// mirrorLayoutMarker marks a mirror this backend created.
const mirrorLayoutMarker = "[paprika]\n\tlayout = 1\n"

// mirrorConfig is a mirror's git config. Packs are kept as received
// (unpackLimit 1), so a fetch's size is the size of the packs it adds, and gc
// runs in the foreground, under the fetch's deadline, never detached.
func mirrorConfig(repoURL string) string {
	quoted := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(repoURL)
	return "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\tlogallrefupdates = false\n" +
		"[remote \"origin\"]\n\turl = \"" + quoted + "\"\n\tpromisor = true\n\tpartialclonefilter = blob:none\n" +
		"[transfer]\n\tunpackLimit = 1\n[fetch]\n\tunpackLimit = 1\n" +
		"[gc]\n\tautoDetach = false\n[maintenance]\n\tautoDetach = false\n" + mirrorLayoutMarker
}

// reset removes the mirror; the next resolve rebuilds it.
func (r *cliRepo) reset() error {
	r.life.Lock()
	defer r.life.Unlock()
	r.inited.Store(false)
	if err := os.RemoveAll(r.dir); err != nil {
		return fmt.Errorf("remove git mirror: %w", err)
	}
	return nil
}

// touch records that the mirror was used, for LRU eviction.
func (r *cliRepo) touch() {
	stamp := filepath.Join(r.dir, mirrorUsedFile)
	now := time.Now()
	if err := os.Chtimes(stamp, now, now); err != nil {
		_ = os.WriteFile(stamp, nil, 0o600) //nolint:errcheck // best effort: an unstamped mirror is evicted first
	}
}

// mirrorUsedFile's mtime is when the mirror was last used.
const mirrorUsedFile = "paprika-used"

// lockFetch takes the mirror's write lock, waiting no longer than ctx allows.
func (r *cliRepo) lockFetch(ctx context.Context) (func(), error) {
	select {
	case r.fetchSlot <- struct{}{}:
		return func() { <-r.fetchSlot }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for git mirror %s: %w", redactURL(r.url), ctx.Err())
	}
}

// hasCommit reports whether the mirror holds sha's commit, and with it its
// trees: every fetch is blob:none, which sends a commit's trees.
func (r *cliRepo) hasCommit(ctx context.Context, sha string) bool {
	_, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"cat-file", "-e", sha + "^{commit}"}})
	return err == nil
}

// ensureCommit makes sure the mirror holds sha. Concurrent requests for one
// commit share one fetch, which runs detached from any one request's
// cancellation, under the fetch timeout, so a request that gives up never
// wastes a fetch another one is waiting on.
func (r *cliRepo) ensureCommit(ctx context.Context, sha, ref string, depth int, creds *lazyCred) error {
	r.life.RLock()
	present := r.hasCommit(ctx, sha)
	r.life.RUnlock()
	if present {
		paprikametrics.GitCacheLookups.Add(ctx, 1, metric.WithAttributes(
			attribute.String("layer", "commit"), attribute.String("result", string(lookupHit))))
		return nil
	}
	ch := r.commits.DoChan(sha, func() (any, error) {
		workCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), currentGitSettings().fetchTimeout)
		defer cancel()
		return nil, r.fetchCommit(workCtx, sha, ref, depth, creds)
	})
	select {
	case res := <-ch:
		result := lookupMiss
		if res.Shared {
			result = lookupShared
		}
		paprikametrics.GitCacheLookups.Add(ctx, 1, metric.WithAttributes(
			attribute.String("layer", "commit"), attribute.String("result", string(result))))
		return res.Err
	case <-ctx.Done():
		return fmt.Errorf("fetch commit %s: request ended while the fetch continues: %w", sha, ctx.Err())
	}
}

// fetchCommit fetches sha with its trees and no blobs.
func (r *cliRepo) fetchCommit(ctx context.Context, sha, ref string, depth int, creds *lazyCred) error {
	r.life.RLock()
	defer r.life.RUnlock()
	release, err := r.lockFetch(ctx)
	if err != nil {
		return err
	}
	defer release()
	if r.hasCommit(ctx, sha) {
		return nil
	}
	cred, err := creds.get(ctx)
	if err != nil {
		return err
	}
	err = r.fetch(ctx, "fetch-commit", cred, fetchOpts{depth: depth}, "+"+sha+":"+commitRefPrefix+sha)
	if err != nil && gitStderrContains(err, "does not allow request for unadvertised object") {
		// A server that refuses an exact commit (protocol v0 without
		// allowAnySHA1InWant) still sends it under a ref.
		err = r.fetchUnderRef(ctx, cred, sha, ref, depth)
	}
	if err != nil {
		if isLocalFetchFailure(err) {
			return &localGitError{err: fmt.Errorf("fetch commit %s: %w", sha, err)}
		}
		if gitStderrContains(err, "not our ref") {
			return fmt.Errorf("fetch commit %s of %s: the remote has no such commit (force-pushed away?): %w", sha, redactURL(r.url), err)
		}
		return fmt.Errorf("fetch commit %s of %s: %w", sha, redactURL(r.url), err)
	}
	if !r.hasCommit(ctx, sha) {
		return fmt.Errorf("fetch commit %s of %s: the fetch did not deliver it", sha, redactURL(r.url))
	}
	r.maintain(ctx)
	return nil
}

// isLocalFetchFailure reports whether a fetch failed on the mirror's own
// objects (a truncated pack, a corrupt object) rather than on the remote.
func isLocalFetchFailure(err error) bool {
	if gitStderrContains(err, "remote error", "unable to access", "could not read from remote",
		"authentication failed", "repository not found", "the remote end hung up") {
		return false
	}
	return gitStderrContains(err, "does not match index", "bad object", "corrupt", "inflate",
		"loose object", "unable to read", "invalid object")
}

// fetchUnderRef fetches the ref that named sha, or every branch for a pinned
// commit, from a server that refuses exact commits.
func (r *cliRepo) fetchUnderRef(ctx context.Context, cred *gitCred, sha, ref string, depth int) error {
	if ref != "" {
		return r.fetch(ctx, "fetch-commit", cred, fetchOpts{depth: depth}, "+"+ref+":"+commitRefPrefix+sha)
	}
	// Depth would stop short of an older commit: this fetches every branch's
	// commits and trees, still no blobs.
	return r.fetch(ctx, "fetch-commit", cred, fetchOpts{}, "+refs/heads/*:refs/paprika/heads/*")
}

// fetchOpts are the options of one git fetch.
type fetchOpts struct {
	depth int
	// objects are fetched by ID (blobs), with no negotiation: the mirror's
	// commits say nothing about which blobs it holds.
	objects []string
}

// fetch runs one blobless fetch into the mirror and records its duration and
// the pack bytes it added.
func (r *cliRepo) fetch(ctx context.Context, op string, cred *gitCred, o fetchOpts, specs ...string) error {
	release, err := acquireSlot(ctx, currentGitLimiter().fetches)
	if err != nil {
		return err
	}
	defer release()
	args := []string{"fetch", "--quiet", "--filter=blob:none", "--no-tags", "--no-write-fetch-head",
		"--no-auto-maintenance", "--no-recurse-submodules"}
	if o.depth > 0 {
		args = append(args, "--depth="+strconv.Itoa(o.depth))
	}
	run := gitRun{dir: r.dir, cred: cred}
	if len(o.objects) > 0 {
		args = append([]string{"-c", "fetch.negotiationAlgorithm=noop"}, append(args, "--stdin")...)
		run.stdin = strings.NewReader(strings.Join(o.objects, "\n") + "\n")
	}
	run.args = append(append(args, "origin"), specs...)
	before := mirrorPackBytes(r.dir)
	start := time.Now()
	err = observeGitNetwork(ctx, op, func() error {
		_, runErr := execGit(ctx, run)
		return runErr
	})
	received := max(mirrorPackBytes(r.dir)-before, 0)
	paprikametrics.GitFetchReceived.Add(ctx, received, metric.WithAttributes(attribute.String("op", op)))
	log.FromContext(ctx).Info("Fetched git objects", "repo", redactURL(r.url), "op", op,
		"refspecs", specs, "objects", len(o.objects), "depth", o.depth,
		"bytes", received, "duration", time.Since(start).Round(time.Millisecond).String(), "error", errString(err))
	return err
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// mirrorPackBytes is the size of the mirror's packs.
func mirrorPackBytes(dir string) int64 {
	entries, err := os.ReadDir(filepath.Join(dir, "objects", "pack"))
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".pack") {
			continue
		}
		if info, infoErr := e.Info(); infoErr == nil {
			total += info.Size()
		}
	}
	return total
}

// maintain keeps the mirror bounded after a fetch: it drops all but the
// newest maxMirrorRefs commit refs and lets gc repack once enough packs
// accumulate. Failures only cost disk, so they are logged, not returned.
func (r *cliRepo) maintain(ctx context.Context) {
	logger := log.FromContext(ctx)
	out, err := execGit(ctx, gitRun{dir: r.dir, args: []string{
		"for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/paprika/",
	}})
	if err != nil {
		logger.Error(err, "List git mirror refs", "repo", redactURL(r.url))
		return
	}
	refs := strings.Fields(string(out))
	if len(refs) > maxMirrorRefs {
		var del strings.Builder
		for _, ref := range refs[maxMirrorRefs:] {
			del.WriteString("delete " + ref + "\n")
		}
		if _, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"update-ref", "--stdin"}, stdin: strings.NewReader(del.String())}); err != nil {
			logger.Error(err, "Prune git mirror refs", "repo", redactURL(r.url))
		}
	}
	if _, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"gc", "--auto", "--quiet"}}); err != nil {
		logger.Error(err, "Repack git mirror", "repo", redactURL(r.url))
	}
}

// pathTree returns the tree at srcPath in sha. The root tree is looked up
// too: a commit whose own tree is missing is a broken mirror, while a path
// that is missing or not a directory is the source's error.
func (r *cliRepo) pathTree(ctx context.Context, sha, srcPath string) (string, error) {
	r.life.RLock()
	defer r.life.RUnlock()
	query := sha + "^{tree}\n" + sha + ":" + srcPath + "\n"
	out, err := execGit(ctx, gitRun{dir: r.dir, args: []string{"cat-file", "--batch-check"}, stdin: strings.NewReader(query)})
	if err != nil {
		return "", &localGitError{err: err}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", &localGitError{err: fmt.Errorf("unexpected cat-file output %q", out)}
	}
	if root := strings.Fields(lines[0]); len(root) != 3 || root[1] != "tree" {
		return "", &localGitError{err: fmt.Errorf("commit %s has no tree in the mirror", sha)}
	}
	fields := strings.Fields(lines[1])
	if len(fields) != 3 || fields[1] != "tree" {
		return "", fmt.Errorf("checkout tree: path %q is not a directory in %s", srcPath, sha)
	}
	return fields[0], nil
}
