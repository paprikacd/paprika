// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
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
	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/plumbing/transport/http"

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
}

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
	key := RepoCacheKey(g.RepoURL, g.credentialID())
	mirrorDir := filepath.Join(g.WorkDir, "git-mirrors", key)
	worktreeDir := filepath.Join(g.WorkDir, "git-clones", key)

	lock := repoLock(key)
	lock.Lock()
	defer lock.Unlock()

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
		// The materialization marker lives next to the worktree dir.
		if err := os.Remove(path + ".rev"); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove git cache marker %s: %w", path, err)
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
		if fetchErr := g.fetchMirror(ctx, repo, auth); fetchErr != nil {
			return nil, fetchErr
		}
		if headErr := g.refreshMirrorHEAD(repo); headErr != nil {
			return nil, headErr
		}
		return repo, nil
	}
	if !errors.Is(err, git.ErrRepositoryNotExists) {
		return nil, fmt.Errorf("open mirror %s: %w", g.RepoURL, err)
	}

	return g.createMirror(ctx, mirrorDir, auth)
}

func (g *GitSource) fetchMirror(ctx context.Context, repo *git.Repository, auth transport.AuthMethod) error {
	fetchErr := repo.FetchContext(ctx, &git.FetchOptions{
		Auth:     auth,
		Progress: nil,
		Depth:    g.depth(),
		RefSpecs: g.mirrorRefSpecs(),
	})
	// Fallbacks: a short revision may name a tag rather than a branch, and
	// servers without uploadpack.allowAnySHA1InWant reject exact-SHA
	// refspecs — the commit may still be reachable from a branch head.
	if (isRefNotFoundError(fetchErr) || errors.Is(fetchErr, git.ErrExactSHA1NotSupported)) && !g.FetchAllRefs {
		rev := strings.TrimSpace(g.Revision)
		var retry []config.RefSpec
		switch {
		case rev == "" || isHexSHA(rev):
			retry = []config.RefSpec{"+refs/heads/*:refs/heads/*"}
		case !strings.HasPrefix(rev, "refs/"):
			retry = []config.RefSpec{config.RefSpec("+refs/tags/" + rev + ":refs/tags/" + rev)}
		}
		if retry != nil {
			fetchErr = repo.FetchContext(ctx, &git.FetchOptions{
				Auth: auth, Depth: g.depth(), RefSpecs: retry,
			})
		}
	}
	if fetchErr != nil && !errors.Is(fetchErr, git.NoErrAlreadyUpToDate) {
		return fmt.Errorf("fetch repo %s: %w", g.RepoURL, fetchErr)
	}
	return nil
}

func isRefNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "couldn't find remote ref") ||
		strings.Contains(msg, "no such ref was advertised")
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
		return []config.RefSpec{config.RefSpec(rev + ":" + pinnedCommitRefPrefix + rev)}
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

	if err := g.fetchMirror(ctx, repo, auth); err != nil {
		return nil, err
	}
	if err := g.refreshMirrorHEAD(repo); err != nil {
		return nil, err
	}
	return repo, nil
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

	if err := g.checkoutTree(mirrorRepo, hash, worktreeDir); err != nil {
		return "", err
	}
	return hash.String(), nil
}

// defaultMirrorRef names the mirror-local ref that records the remote's
// HEAD symref when Revision is empty.
const defaultMirrorRef = "refs/paprika-default/HEAD"

// checkoutTree materializes the commit's tree directly from mirror objects —
// no second repository and no file transport. When Path is set only that
// subtree is written (sparse materialization): the mirror carries the whole
// history, but a monorepo caller pays only for the subtree it renders.
// A sibling marker file records the materialized hash so re-resolves of the
// same revision are near-free.
func (g *GitSource) checkoutTree(repo *git.Repository, hash *plumbing.Hash, worktreeDir string) error {
	marker := worktreeDir + ".rev"
	// #nosec G304 -- marker path is derived from our own WorkDir.
	if existing, readErr := os.ReadFile(marker); readErr == nil && string(existing) == hash.String() {
		if info, statErr := os.Stat(worktreeDir); statErr == nil && info.IsDir() {
			return nil
		}
	}

	commit, err := object.GetCommit(repo.Storer, *hash)
	if err != nil {
		return fmt.Errorf("checkout tree: read commit %s: %w", *hash, err)
	}
	root, err := commit.Tree()
	if err != nil {
		return fmt.Errorf("checkout tree: read root tree: %w", err)
	}

	dest := worktreeDir
	tree := root
	if g.Path != "" {
		entry, findErr := root.FindEntry(g.Path)
		if findErr != nil || entry.Mode != filemode.Dir {
			return fmt.Errorf("checkout tree: path %q is not a directory in %s", g.Path, *hash)
		}
		subtree, treeErr := root.Tree(g.Path)
		if treeErr != nil {
			return fmt.Errorf("checkout tree: read subtree %s: %w", g.Path, treeErr)
		}
		tree = subtree
		dest = filepath.Join(worktreeDir, g.Path)
	}

	if rmErr := os.RemoveAll(worktreeDir); rmErr != nil {
		return fmt.Errorf("checkout tree: clear stale worktree: %w", rmErr)
	}
	if mkErr := os.MkdirAll(dest, 0o750); mkErr != nil {
		return fmt.Errorf("checkout tree: create worktree dir: %w", mkErr)
	}

	walker := object.NewTreeWalker(tree, true, nil)
	defer walker.Close()
	for {
		name, entry, walkErr := walker.Next()
		if errors.Is(walkErr, io.EOF) {
			break
		}
		if walkErr != nil {
			return fmt.Errorf("checkout tree: walk tree: %w", walkErr)
		}
		target := filepath.Join(dest, name)
		mode := entry.Mode
		switch {
		case mode.IsRegular():
			blob, blobErr := object.GetBlob(repo.Storer, entry.Hash)
			if blobErr != nil {
				return fmt.Errorf("checkout tree: read blob %s: %w", name, blobErr)
			}
			perm := 0o640
			if mode == filemode.Executable {
				perm = 0o750
			}
			if writeErr := writeBlob(target, blob, os.FileMode(perm)); writeErr != nil {
				return writeErr
			}
		case mode == filemode.Symlink:
			blob, blobErr := object.GetBlob(repo.Storer, entry.Hash)
			if blobErr != nil {
				return fmt.Errorf("checkout tree: read symlink %s: %w", name, blobErr)
			}
			targetContent, readErr := blobReaderString(blob)
			if readErr != nil {
				return readErr
			}
			if mkErr := os.MkdirAll(filepath.Dir(target), 0o750); mkErr != nil {
				return fmt.Errorf("checkout tree: create dir for %s: %w", name, mkErr)
			}
			if linkErr := os.Symlink(targetContent, target); linkErr != nil {
				return fmt.Errorf("checkout tree: create symlink %s: %w", name, linkErr)
			}
		default:
			// Submodules, empty entries: nothing to materialize.
		}
	}

	if err := os.WriteFile(marker, []byte(hash.String()), 0o600); err != nil {
		return fmt.Errorf("checkout tree: write revision marker: %w", err)
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
	defer func() { _ = reader.Close() }()
	// #nosec G304 -- path is under our controlled worktree dir.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("checkout tree: open %s: %w", path, err)
	}
	if _, err := io.Copy(f, reader); err != nil {
		_ = f.Close()
		return fmt.Errorf("checkout tree: write %s: %w", path, err)
	}
	return f.Close()
}

func blobReaderString(blob *object.Blob) (string, error) {
	reader, err := blob.Reader()
	if err != nil {
		return "", fmt.Errorf("checkout tree: read blob: %w", err)
	}
	defer func() { _ = reader.Close() }()
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
	auth, err := g.authMethod(ctx)
	if err != nil {
		return fmt.Errorf("auth for pinned commit fetch: %w", err)
	}
	refSpec := config.RefSpec(sha + ":" + pinnedCommitRefPrefix + sha)
	fetchErr := repo.FetchContext(ctx, &git.FetchOptions{
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

func (g *GitSource) branchReference() string {
	if g.isBranchReference() {
		rev := strings.TrimSpace(g.Revision)
		if rev == "" {
			return "refs/heads/main"
		}
		if strings.HasPrefix(rev, "refs/heads/") {
			return rev
		}
		if !strings.HasPrefix(rev, "refs/") {
			return "refs/heads/" + rev
		}
	}
	return ""
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
