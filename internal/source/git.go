// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
	"github.com/go-git/go-git/v5/storage"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	paprikametrics "github.com/benebsworth/paprika/internal/metrics"
)

// GitAuth holds authentication credentials for a git repository.
type GitAuth struct {
	Username  string
	Password  string
	Token     string
	GitHubApp *GitHubAppAuth
}

// GitSource represents a git repository source.
type GitSource struct {
	RepoURL  string
	Revision string
	Path     string
	WorkDir  string
	Auth     GitAuth
	Shallow  bool
	// Depth is an explicit fetch depth; when >0 it overrides Shallow's
	// implicit depth-1 for branch refs. For pinned commits the fetch is
	// already depth-1 regardless.
	Depth int
	// FetchAllRefs restores the legacy behaviour of fetching every branch
	// head (+refs/heads/*:refs/heads/*). Default is a targeted single-ref
	// fetch — dramatically cheaper on large monorepos.
	FetchAllRefs bool
	// FetchTTL bounds how stale a warm mirror can go for branch/tag
	// revisions before a remote fetch runs — the mirror's FETCH_HEAD mtime
	// is the clock. 0 always fetches (previous behaviour). Pinned commit
	// SHAs are immutable and always skip the remote once mirrored.
	FetchTTL time.Duration
	// Backend selects the fetch implementation; empty is the process default
	// (DefaultGitBackend).
	Backend GitBackend
}

// GitBackend names a git fetch implementation.
type GitBackend string

// Git fetch implementations.
const (
	// GitBackendAuto picks the git CLI when a usable git binary is installed,
	// else go-git.
	GitBackendAuto GitBackend = "auto"
	// GitBackendCLI is the git CLI: a blobless partial clone that downloads
	// only the blobs under Path.
	GitBackendCLI GitBackend = "cli"
	// GitBackendGoGit is the in-process go-git mirror, which downloads every
	// blob of the fetched tree.
	GitBackendGoGit GitBackend = "go-git"
)

var (
	repoLocks  = make(map[string]*sync.Mutex)
	repoLockMu sync.Mutex
)

func repoLock(key string) *sync.Mutex {
	repoLockMu.Lock()
	defer repoLockMu.Unlock()
	if repoLocks[key] == nil {
		repoLocks[key] = &sync.Mutex{}
	}
	return repoLocks[key]
}

// Resolve clones or updates the git repository and returns the local path.
func (g *GitSource) Resolve(ctx context.Context) (*ResolveResult, error) {
	start := time.Now()
	result, err := g.resolve(ctx)
	// The histogram unit is seconds — recording raw milliseconds put every
	// observation in the +Inf bucket and made the histogram useless.
	elapsed := time.Since(start).Seconds()

	op := "fetch"
	if result == nil || result.LocalPath == "" {
		op = "clone"
	}
	paprikametrics.GitOperations.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", op)))
	if err != nil {
		paprikametrics.GitErrors.Add(ctx, 1, metric.WithAttributes(attribute.String("operation", op)))
	}
	paprikametrics.GitDuration.Record(ctx, elapsed, metric.WithAttributes(attribute.String("operation", op)))
	return result, err
}

func (g *GitSource) resolve(ctx context.Context) (*ResolveResult, error) {
	if g.RepoURL == "" {
		return nil, errors.New("repoURL is required")
	}
	if err := g.checkRepoURL(); err != nil {
		return nil, err
	}
	if g.backend() == GitBackendCLI {
		return g.resolveCLI(ctx)
	}
	key := RepoCacheKey(g.RepoURL, g.credentialID())
	mirrorDir := filepath.Join(g.WorkDir, "git-mirrors", key)
	worktreeDir := filepath.Join(g.WorkDir, "git-clones", key)

	// Keyed by the mirror's directory, not the repository: two work dirs (the
	// controller's release and application renderers) hold two mirrors that
	// never contend.
	lock := repoLock(mirrorDir)
	lock.Lock()
	defer lock.Unlock()
	// A request can wait here behind a detached fetch for up to
	// mirrorFetchBudget, long after its client gave up. One that is already
	// done starts nothing: only a request still live when it takes the lock
	// may start a fetch that outlives it (mirrorFetchContext).
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("resolve %s: request ended while waiting for the repository: %w", g.RepoURL, err)
	}

	result, err := g.resolveLocked(ctx, mirrorDir, worktreeDir)
	if err == nil || (!g.isRecoverableGitCacheError(err) && !g.isStalePinnedRevisionError(err)) {
		return result, err
	}

	if resetErr := resetGitCache(mirrorDir, worktreeDir); resetErr != nil {
		return nil, fmt.Errorf("%w; additionally failed to reset git cache: %w", err, resetErr)
	}
	return g.resolveLocked(ctx, mirrorDir, worktreeDir)
}

func (g *GitSource) resolveLocked(ctx context.Context, mirrorDir, worktreeDir string) (*ResolveResult, error) {
	// #nosec G301 -- git clone requires world-readable directories
	if err := os.MkdirAll(mirrorDir, 0o755); err != nil {
		return nil, fmt.Errorf("create mirror dir: %w", err)
	}

	repo, err := g.openOrCloneMirror(ctx, mirrorDir)
	if err != nil {
		return nil, err
	}

	commitHash, err := g.resolveAndCheckout(ctx, repo, mirrorDir, worktreeDir)
	if err != nil {
		return nil, err
	}

	chartPath := worktreeDir
	if g.Path != "" {
		chartPath = filepath.Join(worktreeDir, g.Path)
	}

	dirHash, err := ComputeDirHash(chartPath)
	if err != nil {
		return nil, fmt.Errorf("compute chart hash: %w", err)
	}

	return &ResolveResult{
		LocalPath: chartPath,
		Hash:      commitHash[:16] + ":" + dirHash[:16],
		Revision:  commitHash,
	}, nil
}

func resetGitCache(paths ...string) error {
	for _, path := range paths {
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove git cache %s: %w", path, err)
		}
		// The materialization markers live next to the worktree dir.
		if matches, globErr := filepath.Glob(path + ".rev*"); globErr == nil {
			for _, m := range matches {
				if err := os.Remove(m); err != nil && !os.IsNotExist(err) {
					return fmt.Errorf("remove git cache marker %s: %w", m, err)
				}
			}
		}
	}
	return nil
}

func (g *GitSource) isRecoverableGitCacheError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	// Corruption signatures from object reads or pack handling.
	if !containsAny(msg, "unexpected eof", "object not found", "invalid checksum", "malformed", "packfile",
		"repository corruption", "zlib") {
		return false
	}
	// A failure naming the remote URL came from the upstream fetch —
	// wiping the local mirror can't repair a remote-side problem.
	if g.RepoURL != "" && strings.Contains(msg, strings.ToLower(g.RepoURL)) {
		return false
	}
	return containsAny(msg, "checkout tree:", "checkout revision", "open mirror", "open worktree",
		"fetch worktree", "fetch repo")
}

func containsAny(s string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

func (g *GitSource) openOrCloneMirror(ctx context.Context, mirrorDir string) (*git.Repository, error) {
	auth, authErr := g.authMethod(ctx)
	if authErr != nil {
		return nil, authErr
	}

	repo, err := git.PlainOpen(mirrorDir)
	if err == nil {
		if g.mirrorFresh(repo, mirrorDir) {
			return repo, nil
		}
		if fetchErr := g.fetchMirrorClean(ctx, repo, mirrorDir, auth); fetchErr != nil {
			return nil, fetchErr
		}
		if headErr := g.refreshMirrorHEAD(repo); headErr != nil {
			return nil, headErr
		}
		g.touchFetchClockIfResolvable(repo, mirrorDir)
		return repo, nil
	}
	if !errors.Is(err, git.ErrRepositoryNotExists) {
		return nil, fmt.Errorf("open mirror %s: %w", g.RepoURL, err)
	}

	return g.createMirror(ctx, mirrorDir, auth)
}

// fetchMirrorClean is the depth-0 fetchMirror and its repair, with the
// partial packs of failed fetches removed: those left by an earlier try, and
// this one's if it fails.
func (g *GitSource) fetchMirrorClean(ctx context.Context, repo *git.Repository, mirrorDir string, auth transport.AuthMethod) error {
	return withPartialPacksRemoved(mirrorDir, func() error {
		// The mirror already holds the branch's last tip, so only what a push
		// changed is fetched (depth 0, see incrementalDepth).
		specs, upToDate, err := g.fetchMirror(ctx, repo, auth, incrementalDepth)
		if err != nil {
			return err
		}
		// Nothing arrived, and in a full mirror nothing dangles: skip the scans
		// of the mirror's refs (0.2 to 0.6 s each at 3000 heads and 3000
		// tags). Never in a shallow mirror. go-git wants every ref there at
		// depth 0, so up to date would mean none of them arrived, the case
		// the repair is for; v5.19 never reports it there (it compares the
		// mirror's shallow boundary with the none a depth-0 fetch sends).
		if upToDate && !isShallow(repo) {
			return nil
		}
		if err := g.repairDanglingRefs(ctx, repo, auth, specs); err != nil {
			return err
		}
		return peelTags(repo)
	})
}

// withPartialPacksRemoved runs fetch with the partial packs of failed fetches
// removed: those left by an earlier try, and fetch's own if it fails.
func withPartialPacksRemoved(mirrorDir string, fetch func() error) error {
	if err := removePartialPacks(mirrorDir); err != nil {
		return err
	}
	fetchErr := fetch()
	if fetchErr == nil {
		return nil
	}
	if err := removePartialPacks(mirrorDir); err != nil {
		return fmt.Errorf("%w; additionally %w", fetchErr, err)
	}
	return fetchErr
}

// incrementalDepth is the depth of a fetch into a mirror that already exists:
// none. A depth makes go-git send deepen plus the mirror's shallow boundary,
// and the server re-sends the new tip's whole tree on every push (on omega-ha
// a 4.8 GB tree per push to brandbrain, 2026-10-12). Without one the server
// assumes the mirror holds the full history behind its refs and sends only
// what those cannot reach. That is right for a fast-forward, and wrong for a
// tip whose merge base is below the boundary (a rollback, a rebase, an old
// tag), or, on a bitmapped server such as GitHub, for a tip that restores a
// tree or blob from below it (a revert): repairDanglingRefs re-fetches at
// depth 1 a ref left on a missing commit, and refetchTip a tip whose tree or
// blob is missing, each for about one tree. Changed blobs still arrive whole
// (go-git requests no thin pack).
//
// What those repairs do not bound: refetchTip cannot repair a commit that is
// not a tip while another ref names a descendant of it (go-git offers that
// ref as a have), so that shape still falls back to the wipe and re-clone. A
// rollback or rebase whose old tip the origin has already pruned (repack
// -adb) fetches the new tip's full history (+3.1 MB against +1.05 MB for one
// tree in the review's fixture). Rewording the last N commits re-sends about
// N trees (2.10 MB against 1.05 MB for N = 2). A repair that fails (a
// timeout, a dropped connection) leaves its ref on a commit the mirror lacks,
// which offers no have, so the next fetch brings the history no other ref
// reaches: all of it when that ref is the mirror's only one (+2.10 MB against
// +1.05 MB in the fixture; about one tree for brandbrain, whose packed size
// is about its tree). Repairing it before that fetch, with this source's
// refspecs, would fetch every moved ref at depth 1 too: a tree per push for as
// long as any ref dangles, and a head deleted upstream in a FetchAllRefs
// mirror always does.
//
// Decided, not overlooked: a tip with no history in common with the mirror
// (a force push onto unrelated or rewritten history, a new orphan branch, a
// FetchAllRefs branch cut from below the boundary) fetches that history in
// full rather than one tree: about a tree per commit of it (+5.25 MB for five
// 1 MiB commits, against +1.05 MB for one tree, in the tests). Such pushes
// are rare, the cost is bounded by the repository's packed size,
// mirrorFetchBudget and the repo-server's /tmp sizeLimit, and for the
// repositories omega-ha follows the packed size is about one tip tree
// (brandbrain: about 5 GB packed, against a 4.8 GB tree). Fetching such tips
// at the shallow depth would need an ancestry check per ref before every
// fetch.
const incrementalDepth = 0

// repairDanglingRefs re-fetches, at depth 1, the refs fetched by specs that
// a depth-0 fetch left on a commit the mirror lacks: the server sends an
// empty pack for a tip it thinks the mirror's haves reach (a rollback, a tag
// moved back, an older tag on a shared mirror). Depth 1 sends the shallow
// boundary, so the server sends the tip's tree, as a first clone does.
func (g *GitSource) repairDanglingRefs(ctx context.Context, repo *git.Repository, auth transport.AuthMethod, specs []config.RefSpec) error {
	dangling, hidden, err := danglingRefs(repo, specs)
	if err != nil || !dangling {
		return err
	}
	fetchCtx, cancel := mirrorFetchContext(ctx)
	defer cancel()
	fetchErr := fetchRefs(fetchCtx, hiddenRemote(repo, g.RepoURL, hidden), auth, 1, specs)
	if fetchErr != nil && !errors.Is(fetchErr, git.NoErrAlreadyUpToDate) {
		return fmt.Errorf("fetch repo %s: %w", g.RepoURL, fetchErr)
	}
	return nil
}

// danglingRefs reports whether a ref fetched by specs is left on a commit
// the mirror lacks, and returns the annotated tags among them: a tag object
// that arrived without its commit is present, so go-git would not want it
// again unless it is hidden. A dangling plain commit is absent already, and
// a ref on an object that is not a commit is not one to repair.
func danglingRefs(repo *git.Repository, specs []config.RefSpec) (dangling bool, hidden map[plumbing.Hash]bool, err error) {
	iter, err := repo.References()
	if err != nil {
		return false, nil, fmt.Errorf("list mirror refs: %w", err)
	}
	defer iter.Close()
	hidden = map[plumbing.Hash]bool{}
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() != plumbing.HashReference || !matchesDst(specs, ref.Name()) {
			return nil
		}
		if target, ok := tagTarget(repo, ref.Hash()); ok {
			if !hasObject(repo, target) {
				dangling, hidden[ref.Hash()] = true, true
			}
			return nil
		}
		if !hasObject(repo, ref.Hash()) {
			dangling = true
		}
		return nil
	})
	if err != nil {
		return false, nil, fmt.Errorf("iterate mirror refs: %w", err)
	}
	return dangling, hidden, nil
}

// isShallow reports whether the mirror has a shallow boundary, or may have.
func isShallow(repo *git.Repository) bool {
	shallow, err := repo.Storer.Shallow()
	return err != nil || len(shallow) > 0
}

// matchesDst reports whether name is the destination of any of specs.
func matchesDst(specs []config.RefSpec, name plumbing.ReferenceName) bool {
	for _, spec := range specs {
		if spec.Reverse().Match(name) {
			return true
		}
	}
	return false
}

// tagTarget returns the commit the annotated tag h points to, if h is one.
// The type is read first, so a lightweight tag's commit is never decoded.
func tagTarget(repo *git.Repository, h plumbing.Hash) (plumbing.Hash, bool) {
	obj, err := repo.Storer.EncodedObject(plumbing.AnyObject, h)
	if err != nil || obj.Type() != plumbing.TagObject {
		return plumbing.ZeroHash, false
	}
	tag, err := object.DecodeTag(repo.Storer, obj)
	if err != nil || tag.TargetType != plumbing.CommitObject {
		return plumbing.ZeroHash, false
	}
	return tag.Target, true
}

// hasObject reports whether the mirror holds h, of any type.
func hasObject(repo *git.Repository, h plumbing.Hash) bool {
	return !errors.Is(repo.Storer.HasEncodedObject(h), plumbing.ErrObjectNotFound)
}

// peeledRefPrefix holds, for each annotated tag in the mirror, a ref on the
// tag's commit. go-git reads every have as a commit, so it never offers an
// annotated tag as one: without these, a mirror only a tag uses fetched the
// tag's whole history at depth 0 on every move.
const peeledRefPrefix = "refs/paprika-peeled/"

// peelTags points refs/paprika-peeled/tags/<tag> at the commit of each
// annotated tag the mirror holds whole, and removes the peeled ref of a tag
// that is gone. One pass over the mirror's refs, and a write only for a
// peeled ref that changes: it runs after every fetch.
func peelTags(repo *git.Repository) error {
	tags, peeled, err := tagRefs(repo)
	if err != nil {
		return err
	}
	for name, h := range tags {
		target, ok := tagTarget(repo, h)
		if !ok || peeled[name] == target || !hasObject(repo, target) {
			continue
		}
		if err := repo.Storer.SetReference(plumbing.NewHashReference(name, target)); err != nil {
			return fmt.Errorf("peel mirror tag %s: %w", name, err)
		}
	}
	for name := range peeled {
		if _, ok := tags[name]; ok {
			continue
		}
		if err := repo.Storer.RemoveReference(name); err != nil {
			return fmt.Errorf("remove peeled ref %s: %w", name, err)
		}
	}
	return nil
}

// tagRefs returns the mirror's tags and its peeled refs, both keyed by the
// peeled ref's name.
func tagRefs(repo *git.Repository) (tags, peeled map[plumbing.ReferenceName]plumbing.Hash, err error) {
	iter, err := repo.References()
	if err != nil {
		return nil, nil, fmt.Errorf("list mirror tags: %w", err)
	}
	defer iter.Close()
	tags, peeled = map[plumbing.ReferenceName]plumbing.Hash{}, map[plumbing.ReferenceName]plumbing.Hash{}
	err = iter.ForEach(func(ref *plumbing.Reference) error {
		if ref.Type() != plumbing.HashReference {
			return nil
		}
		switch name := ref.Name().String(); {
		case strings.HasPrefix(name, "refs/tags/"):
			tags[plumbing.ReferenceName(peeledRefPrefix+strings.TrimPrefix(name, "refs/"))] = ref.Hash()
		case strings.HasPrefix(name, peeledRefPrefix+"tags/"):
			peeled[ref.Name()] = ref.Hash()
		}
		return nil
	})
	if err != nil {
		return nil, nil, fmt.Errorf("iterate mirror tags: %w", err)
	}
	return tags, peeled, nil
}

// hiddenRemote is the mirror's origin, fetching into its storage with hidden
// reported missing: go-git wants a ref's object only when it is missing, and
// offers every commit a ref names as a have.
func hiddenRemote(repo *git.Repository, url string, hidden map[plumbing.Hash]bool) *git.Remote {
	return git.NewRemote(hiddenObjects{Storer: repo.Storer, hidden: hidden},
		&config.RemoteConfig{Name: "origin", URLs: []string{url}})
}

// hiddenObjects is the mirror's storage with some objects reported missing.
type hiddenObjects struct {
	storage.Storer
	hidden map[plumbing.Hash]bool
}

func (s hiddenObjects) EncodedObject(t plumbing.ObjectType, h plumbing.Hash) (plumbing.EncodedObject, error) {
	if s.hidden[h] {
		return nil, plumbing.ErrObjectNotFound
	}
	return s.Storer.EncodedObject(t, h) //nolint:wrapcheck // go-git compares the storer's sentinel errors
}

// PackfileWriter keeps a fetch writing one pack, as it does into the mirror.
func (s hiddenObjects) PackfileWriter() (io.WriteCloser, error) {
	pw, ok := s.Storer.(storer.PackfileWriter)
	if !ok {
		return nil, errors.New("mirror storage cannot write a packfile")
	}
	return pw.PackfileWriter() //nolint:wrapcheck // passed through to go-git
}

// mirrorFetcher is a repository or a remote of one.
type mirrorFetcher interface {
	FetchContext(ctx context.Context, o *git.FetchOptions) error
}

// fetchRefs fetches specs at depth. Every update is forced: a mirror's refs
// are the remote's, and a fast-forward check through hiddenObjects cannot
// see a commit the fetch has just written.
func fetchRefs(ctx context.Context, repo mirrorFetcher, auth transport.AuthMethod, depth int, specs []config.RefSpec) error {
	return repo.FetchContext(ctx, &git.FetchOptions{ //nolint:wrapcheck // callers wrap, and compare go-git's sentinels
		Auth: auth, Depth: depth, RefSpecs: specs, Force: true,
	})
}

// fetchMirror fetches this source's refs at depth and returns the refspecs
// the fetch used, and whether go-git reported them up to date.
func (g *GitSource) fetchMirror(ctx context.Context, repo mirrorFetcher, auth transport.AuthMethod, depth int) ([]config.RefSpec, bool, error) {
	fetchCtx, cancel := mirrorFetchContext(ctx)
	defer cancel()
	specs := g.mirrorRefSpecs()
	fetchErr := fetchRefs(fetchCtx, repo, auth, depth, specs)
	// Fallbacks: a short revision may name a tag rather than a branch, and
	// servers without uploadpack.allowAnySHA1InWant reject exact-SHA
	// refspecs — the commit may still be reachable from a branch head.
	if (isRefNotFoundError(fetchErr) || errors.Is(fetchErr, git.ErrExactSHA1NotSupported)) && !g.FetchAllRefs {
		if retry := g.retryRefSpecs(); retry != nil {
			specs = retry
			fetchErr = fetchRefs(fetchCtx, repo, auth, depth, retry)
		}
	}
	upToDate := errors.Is(fetchErr, git.NoErrAlreadyUpToDate)
	if fetchErr != nil && !upToDate {
		return nil, false, fmt.Errorf("fetch repo %s: %w", g.RepoURL, fetchErr)
	}
	return specs, upToDate, nil
}

// retryRefSpecs is what fetchMirror fetches when mirrorRefSpecs names no ref.
func (g *GitSource) retryRefSpecs() []config.RefSpec {
	rev := strings.TrimSpace(g.Revision)
	switch {
	case rev == "" || isHexSHA(rev):
		return []config.RefSpec{"+refs/heads/*:refs/heads/*"}
	case !strings.HasPrefix(rev, "refs/"):
		return []config.RefSpec{config.RefSpec("+refs/tags/" + rev + ":refs/tags/" + rev)}
	default:
		return nil
	}
}

func isRefNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "couldn't find remote ref") ||
		strings.Contains(msg, "no such ref was advertised")
}

// mirrorFresh reports whether the mirror can answer this resolve without a
// remote round trip:
//
//   - pinned commit SHAs are immutable — once refs/paprika-pinned/<sha> (or
//     the object) exists locally, the remote can't teach us anything new
//   - branches/tags honor FetchTTL — the mirror's fetch-clock file bounds
//     staleness, so poll loops don't issue a fetch per resolve
//
// A zero FetchTTL preserves the previous always-fetch semantics.
func (g *GitSource) mirrorFresh(repo *git.Repository, mirrorDir string) bool {
	if isHexSHA(strings.TrimSpace(g.Revision)) {
		if ref, err := repo.Reference(plumbing.ReferenceName(pinnedCommitRefPrefix+g.Revision), true); err == nil && ref.Hash().String() == g.Revision {
			return true
		}
		// The commit may sit under a head after an all-heads fetch.
		if _, err := object.GetCommit(repo.Storer, plumbing.NewHash(g.Revision)); err == nil {
			return true
		}
	}
	if g.FetchTTL <= 0 {
		return false
	}
	info, err := os.Stat(fetchClockFile(mirrorDir))
	if err != nil {
		return false
	}
	return time.Since(info.ModTime()) < g.FetchTTL
}

// fetchClockFile is the freshness clock — go-git doesn't write FETCH_HEAD,
// so we stamp our own after every successful fetch.
func fetchClockFile(mirrorDir string) string { return mirrorDir + ".lastfetch" }

// touchFetchClockIfResolvable stamps the clock only when the revision
// resolves to a commit in the mirror: a fetch that left it missing must not
// cache that failure for the whole FetchTTL.
func (g *GitSource) touchFetchClockIfResolvable(repo *git.Repository, mirrorDir string) {
	hash, err := g.resolveRevision(repo, g.Revision)
	if err != nil {
		return
	}
	if _, err := object.GetCommit(repo.Storer, *hash); err != nil {
		return
	}
	touchFetchClock(mirrorDir)
}

func touchFetchClock(mirrorDir string) {
	// Best-effort: a failed touch just means the next resolve re-fetches.
	if err := os.WriteFile(fetchClockFile(mirrorDir),
		[]byte(time.Now().UTC().Format(time.RFC3339)), 0o600); err != nil {
		return
	}
}

// mirrorRefSpecs returns the minimal refspec needed for the requested
// revision. Fetching only the required ref (instead of every branch head)
// is the main efficiency win on repos with many branches and tags; pinned
// commits and HEAD both route through namespace-local refs.
func (g *GitSource) mirrorRefSpecs() []config.RefSpec {
	if g.FetchAllRefs {
		return []config.RefSpec{"+refs/heads/*:refs/heads/*"}
	}
	rev := strings.TrimSpace(g.Revision)
	switch {
	case rev == "":
		// Fetch the server's HEAD symref — resolves the remote's default
		// branch without pulling every head.
		return []config.RefSpec{"+HEAD:" + defaultMirrorRef}
	case isHexSHA(rev):
		// Forced like every other spec: a pinned SHA is immutable.
		return []config.RefSpec{config.RefSpec("+" + rev + ":" + pinnedCommitRefPrefix + rev)}
	case strings.HasPrefix(rev, "refs/"):
		return []config.RefSpec{config.RefSpec("+" + rev + ":" + rev)}
	default:
		return []config.RefSpec{config.RefSpec("+refs/heads/" + rev + ":refs/heads/" + rev)}
	}
}

func (g *GitSource) createMirror(ctx context.Context, mirrorDir string, auth transport.AuthMethod) (*git.Repository, error) {
	repo, err := git.PlainInit(mirrorDir, true)
	if err != nil {
		return nil, fmt.Errorf("init mirror %s: %w", g.RepoURL, err)
	}
	if _, err := repo.CreateRemote(&config.RemoteConfig{
		Name: "origin",
		URLs: []string{g.RepoURL},
	}); err != nil {
		return nil, fmt.Errorf("create remote %s: %w", g.RepoURL, err)
	}

	if _, _, err := g.fetchMirror(ctx, repo, auth, g.depth()); err != nil {
		// A first clone that failed (a 5 GB clone cancelled at the client's
		// timeout) holds nothing usable; leave nothing behind.
		if rmErr := os.RemoveAll(mirrorDir); rmErr != nil {
			return nil, fmt.Errorf("%w; additionally failed to remove the partial mirror: %w", err, rmErr)
		}
		return nil, err
	}
	if err := peelTags(repo); err != nil {
		return nil, err
	}
	if err := g.refreshMirrorHEAD(repo); err != nil {
		return nil, err
	}
	g.touchFetchClockIfResolvable(repo, mirrorDir)
	return repo, nil
}

// mirrorFetchBudget bounds one mirror fetch, which runs detached from the
// cancellation of the request that started it (mirrorFetchContext).
var mirrorFetchBudget = 30 * time.Minute

// mirrorFetchContext is the context a mirror fetch runs under: the request's
// values without its cancellation or deadline, bounded by mirrorFetchBudget.
// A first fetch of a large repository takes longer than the repo-server
// client's 5-minute timeout (brandbrain's 3.3 GB shallow tree, at about 10
// MB/s), and a fetch bound to the request was cancelled at 5 minutes every
// time: it never completed, and each try left a partial pack (omega-ha,
// 2026-10-11/12). Detached, the fetch completes while the client retries;
// the repo lock keeps the retry waiting for it rather than starting another.
func mirrorFetchContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), mirrorFetchBudget)
}

// removePartialPacks deletes a mirror's objects/pack/tmp_pack_* files: the
// pack a fetch writes as it downloads, which go-git leaves behind when the
// fetch fails or is cancelled. It runs under the repo lock, so no fetch of
// this mirror is writing one.
func removePartialPacks(mirrorDir string) error {
	matches, err := filepath.Glob(filepath.Join(mirrorDir, "objects", "pack", "tmp_pack_*"))
	if err != nil {
		return fmt.Errorf("find partial packs: %w", err)
	}
	var errs []error
	for _, m := range matches {
		if rmErr := os.Remove(m); rmErr != nil && !os.IsNotExist(rmErr) {
			errs = append(errs, fmt.Errorf("remove partial pack: %w", rmErr))
		}
	}
	return errors.Join(errs...)
}

// refreshMirrorHEAD points the mirror's HEAD at the fetched ref so
// resolveRevision("") can answer via repo.Head(). Pinned-commit fetches
// skip HEAD entirely — the revision resolves from refs/paprika-pinned/.
func (g *GitSource) refreshMirrorHEAD(repo *git.Repository) error {
	rev := strings.TrimSpace(g.Revision)
	var target plumbing.ReferenceName
	switch {
	case rev == "" && !g.FetchAllRefs:
		target = plumbing.ReferenceName(defaultMirrorRef)
	default:
		ref, ok, err := firstCloneableMirrorRef(repo)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		target = ref
	}
	if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, target)); err != nil {
		return fmt.Errorf("set mirror HEAD: %w", err)
	}
	return nil
}

func (g *GitSource) resolveAndCheckout(ctx context.Context, mirrorRepo *git.Repository, mirrorDir, worktreeDir string) (string, error) {
	hash, err := g.resolveRevision(mirrorRepo, g.Revision)
	if err != nil && isHexSHA(strings.TrimSpace(g.Revision)) {
		// A shallow mirror never receives commits below its boundary:
		// "have" lines transitively claim ancestors, and go-git only sends
		// shallow declarations when a depth is requested. Pinned release
		// revisions can sit below the boundary after the cache is rebuilt,
		// so fetch the exact commit before giving up.
		if fetchErr := g.fetchPinnedCommit(ctx, mirrorRepo, g.Revision); fetchErr == nil {
			hash, err = g.resolveRevision(mirrorRepo, g.Revision)
		}
	}
	if err != nil {
		return "", err
	}

	err = g.checkoutTree(mirrorRepo, hash, worktreeDir)
	if errors.Is(err, plumbing.ErrObjectNotFound) {
		// A tree or blob a depth-0 fetch left out (see incrementalDepth).
		// Fetch the tip again at depth 1, which sends the whole tree, before
		// the recoverable error wipes the mirror and every source's refs.
		if fetchErr := g.refetchTip(ctx, mirrorRepo, mirrorDir, *hash); fetchErr == nil {
			err = g.checkoutTree(mirrorRepo, hash, worktreeDir)
		}
	}
	if err != nil {
		return "", err
	}
	return hash.String(), nil
}

// refetchTip fetches this source's refs again at depth 1 with commit, and
// the annotated tags on it, hidden: go-git wants only a ref whose object is
// missing, and the commit is present, only its tree or a blob under it is
// not. Depth 1 sends the shallow boundary, so the server sends the whole
// tree rather than assuming the mirror holds the history below it. The token
// is minted under the fetch's detached context, as fetchPinnedCommit's is:
// the fetch before this one may have outlived the request.
func (g *GitSource) refetchTip(ctx context.Context, repo *git.Repository, mirrorDir string, commit plumbing.Hash) error {
	fetchCtx, cancel := mirrorFetchContext(ctx)
	defer cancel()
	auth, err := g.authMethod(fetchCtx)
	if err != nil {
		return err
	}
	hidden := map[plumbing.Hash]bool{commit: true}
	tags, err := repo.Tags()
	if err != nil {
		return fmt.Errorf("list mirror tags: %w", err)
	}
	defer tags.Close()
	err = tags.ForEach(func(ref *plumbing.Reference) error {
		if target, ok := tagTarget(repo, ref.Hash()); ok && target == commit {
			hidden[ref.Hash()] = true
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("iterate mirror tags: %w", err)
	}
	return withPartialPacksRemoved(mirrorDir, func() error {
		_, _, fetchErr := g.fetchMirror(ctx, hiddenRemote(repo, g.RepoURL, hidden), auth, 1)
		return fetchErr
	})
}

// defaultMirrorRef names the mirror-local ref that records the remote's
// HEAD symref when Revision is empty.
const defaultMirrorRef = "refs/paprika-default/HEAD"

// checkoutTree materializes the commit's tree directly from mirror objects —
// no second repository and no file transport. When Path is set only that
// subtree is written (sparse materialization): the mirror carries the whole
// history, but a monorepo caller pays only for the subtree it renders.
//
// worktreeDir is shared by all resolves of the same repo+credentials — each
// requested path scope gets its own sibling marker recording the hash it
// materialized, so templates with different paths never shadow each other.
func (g *GitSource) checkoutTree(repo *git.Repository, hash *plumbing.Hash, worktreeDir string) error {
	marker := checkoutMarker(worktreeDir, g.Path)
	stamp := checkoutMarkerFormat + hash.String()

	tree, dest, err := g.checkoutScope(repo, hash, worktreeDir)
	if err != nil {
		return err
	}

	if checkoutCurrent(marker, stamp, dest) {
		return nil
	}

	// Only the requested scope is replaced — other subtrees in worktreeDir
	// may have been materialized for other callers.
	if rmErr := os.RemoveAll(dest); rmErr != nil {
		return fmt.Errorf("checkout tree: clear stale worktree: %w", rmErr)
	}
	if mkErr := os.MkdirAll(dest, 0o750); mkErr != nil {
		return fmt.Errorf("checkout tree: create worktree dir: %w", mkErr)
	}

	if err := g.materializeTree(repo, tree, dest); err != nil {
		return err
	}
	if err := verifySymlinks(dest); err != nil {
		return err
	}

	if err := os.WriteFile(marker, []byte(stamp), 0o600); err != nil {
		return fmt.Errorf("checkout tree: write revision marker: %w", err)
	}
	return nil
}

// checkoutCurrent reports whether dest holds the checkout marker records.
func checkoutCurrent(marker, stamp, dest string) bool {
	// #nosec G304 -- marker path is derived from our own WorkDir.
	existing, err := os.ReadFile(marker)
	if err != nil || string(existing) != stamp {
		return false
	}
	info, err := os.Stat(dest)
	return err == nil && info.IsDir()
}

// checkoutMarkerFormat prefixes the hash in a revision marker. A marker
// without it may record a checkout that a missing subtree truncated (the
// TreeWalker read one as the end of the tree), so that scope is written again.
const checkoutMarkerFormat = "v2 "

// checkoutMarker names the per-scope revision marker next to the worktree
// dir — ".rev" for a full-tree checkout, ".rev-<path>" for a subtree.
func checkoutMarker(worktreeDir, path string) string {
	if path == "" {
		return worktreeDir + ".rev"
	}
	sum := sha256.Sum256([]byte(path))
	return fmt.Sprintf("%s.rev-%s", worktreeDir, hex.EncodeToString(sum[:])[:8])
}

// checkoutScope resolves the commit's tree and, when Path is set, scopes to
// that subtree — returning the tree to walk and the destination dir.
func (g *GitSource) checkoutScope(repo *git.Repository, hash *plumbing.Hash, worktreeDir string) (*object.Tree, string, error) {
	commit, err := object.GetCommit(repo.Storer, *hash)
	if err != nil {
		return nil, "", fmt.Errorf("checkout tree: read commit %s: %w", *hash, err)
	}
	root, err := commit.Tree()
	if err != nil {
		return nil, "", fmt.Errorf("checkout tree: read root tree: %w", err)
	}
	if g.Path == "" {
		return root, worktreeDir, nil
	}
	// One component at a time. root.FindEntry(g.Path) reads each component
	// as a tree, and the mirror reports an object of another type (a symlink,
	// a file, a gitlink) as ErrObjectNotFound, which would send a Path that is
	// not a directory through refetchTip and the wipe on every resolve.
	// root.Tree(g.Path) reports a missing tree as ErrDirectoryNotFound, which
	// no recovery matches (see incrementalDepth).
	tree, dir := root, ""
	for _, name := range strings.Split(g.Path, "/") {
		entry, findErr := tree.FindEntry(name)
		if findErr != nil || entry.Mode != filemode.Dir {
			return nil, "", fmt.Errorf("checkout tree: path %q is not a directory in %s", g.Path, *hash)
		}
		dir = path.Join(dir, name)
		if tree, err = readSubtree(repo, entry.Hash, dir); err != nil {
			return nil, "", err
		}
	}
	return tree, filepath.Join(worktreeDir, g.Path), nil
}

// readSubtree reads the tree of the directory entry h, found at name. Only an
// absent tree is ErrObjectNotFound, the cache error refetchTip repairs: the
// mirror reports an object of another type the same way, and that is not a
// cache error. Any other failure (a malformed tree) is wrapped as it is and
// classified as on master: isRecoverableGitCacheError wipes the mirror once
// per resolve, as it did for the TreeWalker's error.
func readSubtree(repo *git.Repository, h plumbing.Hash, name string) (*object.Tree, error) {
	tree, err := object.GetTree(repo.Storer, h)
	switch {
	case err == nil:
		return tree, nil
	case errors.Is(err, plumbing.ErrObjectNotFound) && hasObject(repo, h):
		return nil, fmt.Errorf("checkout tree: entry %q is not a tree", name)
	default:
		return nil, fmt.Errorf("checkout tree: read tree %s: %w", name, err)
	}
}

// maxCheckoutTreeDepth is go-git's TreeWalker depth cap: a crafted tree
// nested deeper is an error, not a recursion as deep as the tree.
const maxCheckoutTreeDepth = 1024

// materializeTree writes every entry of tree under dest. A subtree the
// mirror lacks is a recoverable error, never a truncated checkout: go-git's
// TreeWalker ended at one with io.EOF, as at the end of the tree. Names are
// validated as the walker validated them, by FindEntry for a directory and
// TreeEntryFile for a file.
func (g *GitSource) materializeTree(repo *git.Repository, tree *object.Tree, dest string) error {
	return g.materializeDir(repo, tree, newCheckoutGuard(dest), "", 0)
}

// materializeDir writes tree, found at dir and depth below the checkout's
// root, under guard's root.
func (g *GitSource) materializeDir(repo *git.Repository, tree *object.Tree, guard *checkoutGuard, dir string, depth int) error {
	if depth > maxCheckoutTreeDepth {
		return fmt.Errorf("checkout tree: %s: %w", dir, object.ErrMaxTreeDepth)
	}
	for i := range tree.Entries {
		entry := &tree.Entries[i]
		name := path.Join(dir, entry.Name)
		if entry.Mode != filemode.Dir {
			if err := g.materializeEntry(tree, name, entry, guard); err != nil {
				return err
			}
			continue
		}
		if _, err := tree.FindEntry(entry.Name); err != nil {
			return fmt.Errorf("checkout tree: tree entry %q in %s: %w", entry.Name, dir, err)
		}
		subtree, err := readSubtree(repo, entry.Hash, name)
		if err != nil {
			return err
		}
		if err := g.materializeDir(repo, subtree, guard, name, depth+1); err != nil {
			return err
		}
	}
	return nil
}

// materializeEntry writes one entry of tree, found at name, under dest.
func (g *GitSource) materializeEntry(tree *object.Tree, name string, entry *object.TreeEntry, guard *checkoutGuard) error {
	if err := guard.parentsOK(name); err != nil {
		return err
	}
	target := filepath.Join(guard.root, name)
	mode := entry.Mode
	switch {
	// IsRegular is false for an executable (100755): those were skipped as
	// if they were submodules, and a chart's scripts never reached a render.
	case mode.IsRegular() || mode == filemode.Executable:
		file, fileErr := tree.TreeEntryFile(entry)
		if fileErr != nil {
			return fmt.Errorf("checkout tree: read blob %s: %w", name, fileErr)
		}
		perm := 0o640
		if mode == filemode.Executable {
			perm = 0o750
		}
		return writeBlob(target, &file.Blob, os.FileMode(perm))
	case mode == filemode.Symlink:
		return materializeSymlink(tree, name, entry, target)
	default:
		// Submodules, empty entries: nothing to materialize.
		return nil
	}
}

// materializeSymlink writes the symlink entry of tree, found at name, at
// target.
func materializeSymlink(tree *object.Tree, name string, entry *object.TreeEntry, target string) error {
	file, fileErr := tree.TreeEntryFile(entry)
	if fileErr != nil {
		return fmt.Errorf("checkout tree: read symlink %s: %w", name, fileErr)
	}
	targetContent, readErr := blobReaderString(&file.Blob)
	if readErr != nil {
		return readErr
	}
	if err := checkSymlinkTarget(name, targetContent); err != nil {
		return err
	}
	if mkErr := os.MkdirAll(filepath.Dir(target), 0o750); mkErr != nil {
		return fmt.Errorf("checkout tree: create dir for %s: %w", name, mkErr)
	}
	if linkErr := os.Symlink(targetContent, target); linkErr != nil {
		return fmt.Errorf("checkout tree: create symlink %s: %w", name, linkErr)
	}
	return nil
}

func writeBlob(path string, blob *object.Blob, perm os.FileMode) error {
	if mkErr := os.MkdirAll(filepath.Dir(path), 0o750); mkErr != nil {
		return fmt.Errorf("checkout tree: create dir for %s: %w", path, mkErr)
	}
	reader, err := blob.Reader()
	if err != nil {
		return fmt.Errorf("checkout tree: read blob: %w", err)
	}
	defer reader.Close() //nolint:errcheck // safe to ignore close error
	f, err := createFile(path, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, reader); err != nil {
		_ = f.Close() //nolint:errcheck // cleanup after failed write
		return fmt.Errorf("checkout tree: write %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("checkout tree: close %s: %w", path, err)
	}
	return nil
}

func blobReaderString(blob *object.Blob) (string, error) {
	reader, err := blob.Reader()
	if err != nil {
		return "", fmt.Errorf("checkout tree: read blob: %w", err)
	}
	defer reader.Close() //nolint:errcheck // safe to ignore close error
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", fmt.Errorf("checkout tree: read blob content: %w", err)
	}
	return string(data), nil
}

func firstCloneableMirrorRef(repo *git.Repository) (plumbing.ReferenceName, bool, error) {
	iter, err := repo.References()
	if err != nil {
		return "", false, fmt.Errorf("list mirror refs: %w", err)
	}
	defer iter.Close()

	var refs [4]plumbing.ReferenceName
	if err := iter.ForEach(rememberCloneableMirrorRef(&refs)); err != nil {
		return "", false, fmt.Errorf("iterate mirror refs: %w", err)
	}

	for _, name := range refs {
		if name != "" {
			return name, true, nil
		}
	}
	return "", false, nil
}

func rememberCloneableMirrorRef(refs *[4]plumbing.ReferenceName) func(*plumbing.Reference) error {
	return func(ref *plumbing.Reference) error {
		priority := mirrorRefPriority(ref.Name().String())
		if priority < 0 || refs[priority] != "" {
			return nil
		}
		refs[priority] = ref.Name()
		return nil
	}
}

func mirrorRefPriority(name string) int {
	switch {
	case name == "refs/heads/main":
		return 0
	case name == "refs/heads/master":
		return 1
	case strings.HasPrefix(name, "refs/heads/"):
		return 2
	case strings.HasPrefix(name, "refs/tags/"):
		return 3
	default:
		return -1
	}
}

// pinnedCommitRefPrefix namespaces exact-commit fetches in the mirror so the
// worktree can carry them with an explicit refspec.
const pinnedCommitRefPrefix = "refs/paprika-pinned/"

// isStalePinnedRevisionError reports whether err is an unresolvable revision
// for a pinned commit. Pinned commits can fall below a shallow mirror's
// boundary after the cache is rebuilt (pod restart, recovery reset), so the
// caller may safely discard and rebuild the cache when this is true.
func (g *GitSource) isStalePinnedRevisionError(err error) bool {
	return err != nil &&
		isHexSHA(strings.TrimSpace(g.Revision)) &&
		strings.Contains(err.Error(), "not found as branch, tag, or commit")
}

// fetchPinnedCommit fetches one exact commit into the mirror under
// refs/paprika-pinned/. Depth is set so the fetch negotiates shallow
// boundaries correctly; the server must advertise allow-tip/reachable
// sha1-in-want (GitHub does). Transports without it return
// transport.ErrExactSHA1NotSupported and the caller falls back to a full
// cache rebuild.
func (g *GitSource) fetchPinnedCommit(ctx context.Context, repo *git.Repository, sha string) error {
	fetchCtx, cancel := mirrorFetchContext(ctx)
	defer cancel()
	auth, err := g.authMethod(fetchCtx)
	if err != nil {
		return fmt.Errorf("auth for pinned commit fetch: %w", err)
	}
	refSpec := config.RefSpec("+" + sha + ":" + pinnedCommitRefPrefix + sha)
	fetchErr := repo.FetchContext(fetchCtx, &git.FetchOptions{
		Auth:     auth,
		Depth:    1,
		RefSpecs: []config.RefSpec{refSpec},
	})
	if fetchErr != nil && !errors.Is(fetchErr, git.NoErrAlreadyUpToDate) {
		return fmt.Errorf("fetch pinned commit %s: %w", sha, fetchErr)
	}
	return nil
}

func (g *GitSource) resolveRevision(repo *git.Repository, revision string) (*plumbing.Hash, error) {
	if revision == "" {
		head, err := repo.Head()
		if err != nil {
			return nil, fmt.Errorf("get HEAD: %w", err)
		}
		hash := head.Hash()
		return &hash, nil
	}
	for _, ref := range revisionCandidates(revision) {
		h, resolveErr := repo.ResolveRevision(plumbing.Revision(ref))
		if resolveErr == nil {
			return h, nil
		}
	}
	return nil, fmt.Errorf("resolve revision %s: not found as branch, tag, or commit", revision)
}

func revisionCandidates(revision string) []string {
	candidates := make([]string, 0, 6)
	if strings.HasPrefix(revision, "refs/heads/") {
		candidates = append(candidates, "refs/remotes/origin/"+strings.TrimPrefix(revision, "refs/heads/"))
	} else if strings.HasPrefix(revision, "refs/tags/") {
		candidates = append(candidates, revision)
	} else if !strings.HasPrefix(revision, "refs/") {
		candidates = append(candidates,
			"refs/remotes/origin/"+revision,
			"refs/heads/"+revision,
			"refs/tags/"+revision,
		)
	}
	candidates = append(candidates, revision)
	return candidates
}

func (g *GitSource) depth() int {
	if g.Shallow && g.isBranchReference() {
		return 1
	}
	return 0
}

func (g *GitSource) isBranchReference() bool {
	rev := strings.TrimSpace(g.Revision)
	if rev == "" {
		return true
	}
	if strings.HasPrefix(rev, "refs/heads/") {
		return true
	}
	if strings.HasPrefix(rev, "refs/") {
		return false
	}
	return !isHexSHA(rev)
}

var hexSHARe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func isHexSHA(s string) bool {
	return hexSHARe.MatchString(s)
}

func (g *GitSource) credentialID() string {
	if g.Auth.GitHubApp != nil {
		return fmt.Sprintf("github-app:%d:%d", g.Auth.GitHubApp.AppID, g.Auth.GitHubApp.InstallationID)
	}
	if g.Auth.Token != "" {
		return "token:" + g.Auth.Token
	}
	if g.Auth.Username != "" || g.Auth.Password != "" {
		return g.Auth.Username + ":" + g.Auth.Password
	}
	return ""
}

func (g *GitSource) authMethod(ctx context.Context) (transport.AuthMethod, error) {
	return g.Auth.authMethod(ctx)
}

func (a GitAuth) authMethod(ctx context.Context) (transport.AuthMethod, error) {
	if a.GitHubApp != nil {
		token, err := a.GitHubApp.InstallationToken(ctx)
		if err != nil {
			return nil, fmt.Errorf("github app token: %w", err)
		}
		return &http.BasicAuth{Username: "x-access-token", Password: token}, nil
	}
	if a.Token != "" {
		return &http.BasicAuth{Username: "x-access-token", Password: a.Token}, nil
	}
	if a.Username != "" || a.Password != "" {
		return &http.BasicAuth{Username: a.Username, Password: a.Password}, nil
	}
	return nil, nil
}

// Ensure transport.AuthMethod is used.
var _ transport.AuthMethod = (*http.BasicAuth)(nil)
