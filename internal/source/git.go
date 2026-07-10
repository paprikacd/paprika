// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
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
	elapsed := time.Since(start).Milliseconds()

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
	if err == nil || !isRecoverableGitCacheError(err) {
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
	}
	return nil
}

func isRecoverableGitCacheError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if !containsAny(msg, "unexpected eof", "object not found", "invalid checksum", "malformed", "packfile") {
		return false
	}
	return containsAny(msg, "checkout revision", "open mirror", "open worktree", "fetch worktree", "fetch repo")
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
		if headErr := g.setMirrorHEAD(repo); headErr != nil {
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
		RefSpecs: []config.RefSpec{"+refs/heads/*:refs/heads/*"},
	})
	if fetchErr != nil && !errors.Is(fetchErr, git.NoErrAlreadyUpToDate) {
		return fmt.Errorf("fetch repo %s: %w", g.RepoURL, fetchErr)
	}
	return nil
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
	if err := g.setMirrorHEAD(repo); err != nil {
		return nil, err
	}
	return repo, nil
}

func (g *GitSource) setMirrorHEAD(repo *git.Repository) error {
	if branch := g.branchReference(); branch != "" {
		if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, plumbing.ReferenceName(branch))); err != nil {
			return fmt.Errorf("set mirror HEAD: %w", err)
		}
	}
	return nil
}

func (g *GitSource) resolveAndCheckout(ctx context.Context, mirrorRepo *git.Repository, mirrorDir, worktreeDir string) (string, error) {
	hash, err := g.resolveRevision(mirrorRepo, g.Revision)
	if err != nil {
		return "", err
	}
	if headErr := g.setCloneableMirrorHEAD(mirrorRepo, hash); headErr != nil {
		return "", headErr
	}

	worktreeRepo, err := g.openOrCloneWorktree(ctx, mirrorDir, worktreeDir)
	if err != nil {
		return "", err
	}

	wt, err := worktreeRepo.Worktree()
	if err != nil {
		return "", fmt.Errorf("get worktree: %w", err)
	}

	if checkoutErr := wt.Checkout(&git.CheckoutOptions{Hash: *hash, Force: true}); checkoutErr != nil {
		return "", fmt.Errorf("checkout revision %s: %w", g.Revision, checkoutErr)
	}
	return hash.String(), nil
}

func (g *GitSource) setCloneableMirrorHEAD(repo *git.Repository, hash *plumbing.Hash) error {
	if branch := g.branchReference(); branch != "" {
		if _, err := repo.Reference(plumbing.ReferenceName(branch), true); err == nil {
			if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, plumbing.ReferenceName(branch))); err != nil {
				return fmt.Errorf("set mirror HEAD to branch: %w", err)
			}
			return nil
		}
	}
	if ref, ok, err := firstCloneableMirrorRef(repo); err != nil {
		return err
	} else if ok {
		if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, ref)); err != nil {
			return fmt.Errorf("set mirror HEAD to existing ref: %w", err)
		}
		return nil
	}
	if hash == nil {
		return nil
	}
	if err := repo.Storer.SetReference(plumbing.NewHashReference(plumbing.HEAD, *hash)); err != nil {
		return fmt.Errorf("set mirror HEAD to revision: %w", err)
	}
	return nil
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

func (g *GitSource) openOrCloneWorktree(ctx context.Context, mirrorDir, worktreeDir string) (*git.Repository, error) {
	if _, statErr := os.Stat(filepath.Join(worktreeDir, ".git")); statErr == nil {
		return g.openExistingWorktree(ctx, worktreeDir)
	}
	return g.cloneWorktree(ctx, mirrorDir, worktreeDir)
}

func (g *GitSource) openExistingWorktree(ctx context.Context, worktreeDir string) (*git.Repository, error) {
	worktreeRepo, err := git.PlainOpen(worktreeDir)
	if err != nil {
		return nil, fmt.Errorf("open worktree: %w", err)
	}
	if err := worktreeRepo.FetchContext(ctx, &git.FetchOptions{
		Progress: nil,
		RefSpecs: []config.RefSpec{
			"+refs/heads/*:refs/remotes/origin/*",
			"+refs/tags/*:refs/tags/*",
		},
	}); err != nil && !errors.Is(err, git.NoErrAlreadyUpToDate) {
		return nil, fmt.Errorf("fetch worktree: %w", err)
	}
	return worktreeRepo, nil
}

func (g *GitSource) cloneWorktree(ctx context.Context, mirrorDir, worktreeDir string) (*git.Repository, error) {
	if rmErr := os.RemoveAll(worktreeDir); rmErr != nil {
		return nil, fmt.Errorf("remove stale worktree dir: %w", rmErr)
	}
	if mkErr := os.MkdirAll(filepath.Dir(worktreeDir), 0o750); mkErr != nil {
		return nil, fmt.Errorf("create worktree parent dir: %w", mkErr)
	}
	worktreeRepo, err := git.PlainInit(worktreeDir, false)
	if err != nil {
		return nil, fmt.Errorf("init worktree repo: %w", err)
	}
	if _, remoteErr := worktreeRepo.CreateRemote(&config.RemoteConfig{
		Name: "origin",
		URLs: []string{mirrorDir},
	}); remoteErr != nil {
		return nil, fmt.Errorf("create worktree remote: %w", remoteErr)
	}
	err = worktreeRepo.FetchContext(ctx, &git.FetchOptions{
		Progress: nil,
		RefSpecs: []config.RefSpec{
			"+refs/heads/*:refs/remotes/origin/*",
			"+refs/tags/*:refs/tags/*",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("fetch worktree from mirror: %w", err)
	}
	return worktreeRepo, nil
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
