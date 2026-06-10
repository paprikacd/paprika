// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
)

// GitSource represents a git repository source.
type GitSource struct {
	RepoURL   string
	Revision  string
	Path      string
	WorkDir   string
	SecretRef string
}

// Resolve clones or updates the git repository and returns the local path.
func (g *GitSource) Resolve(ctx context.Context) (*ResolveResult, error) {
	cloneDir := filepath.Join(g.WorkDir, "git-clones", SanitizeName(g.RepoURL))
	// #nosec G301 -- git clone requires world-readable directories
	if err := os.MkdirAll(filepath.Dir(cloneDir), 0o755); err != nil {
		return nil, fmt.Errorf("create clone dir: %w", err)
	}

	repo, err := g.cloneOrOpenRepo(ctx, cloneDir)
	if err != nil {
		return nil, err
	}

	if g.Revision != "" {
		if revErr := g.checkoutRevision(repo, g.Revision); revErr != nil {
			return nil, revErr
		}
	}

	head, err := repo.Head()
	if err != nil {
		return nil, fmt.Errorf("get HEAD: %w", err)
	}

	commitHash := head.Hash().String()

	chartPath := cloneDir
	if g.Path != "" {
		chartPath = filepath.Join(cloneDir, g.Path)
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

// cloneOrOpenRepo clones a git repository, or opens and fetches if it already exists.
func (g *GitSource) cloneOrOpenRepo(ctx context.Context, cloneDir string) (*git.Repository, error) {
	repo, err := git.PlainCloneContext(ctx, cloneDir, false, &git.CloneOptions{
		URL: g.RepoURL,
	})
	if err != nil {
		if errors.Is(err, git.ErrRepositoryAlreadyExists) {
			return g.openExistingRepo(ctx, cloneDir)
		}
		return nil, fmt.Errorf("clone repo %s: %w", g.RepoURL, err)
	}
	return repo, nil
}

func (g *GitSource) checkoutRevision(repo *git.Repository, revision string) error {
	wt, wtErr := repo.Worktree()
	if wtErr != nil {
		return fmt.Errorf("get worktree: %w", wtErr)
	}

	var hash *plumbing.Hash
	for _, ref := range []string{
		revision,
		"refs/heads/" + revision,
		"refs/tags/" + revision,
	} {
		h, resolveErr := repo.ResolveRevision(plumbing.Revision(ref))
		if resolveErr == nil {
			hash = h
			break
		}
	}
	if hash == nil {
		return fmt.Errorf("resolve revision %s: not found as branch, tag, or commit", revision)
	}

	if checkoutErr := wt.Checkout(&git.CheckoutOptions{Hash: *hash}); checkoutErr != nil {
		return fmt.Errorf("checkout revision %s: %w", revision, checkoutErr)
	}
	return nil
}

func (g *GitSource) openExistingRepo(ctx context.Context, cloneDir string) (*git.Repository, error) {
	repo, err := git.PlainOpen(cloneDir)
	if err != nil {
		return nil, fmt.Errorf("open existing repo: %w", err)
	}
	fetchErr := repo.FetchContext(ctx, &git.FetchOptions{})
	if fetchErr != nil && !errors.Is(fetchErr, git.NoErrAlreadyUpToDate) {
		return nil, fmt.Errorf("fetch repo: %w", fetchErr)
	}
	return repo, nil
}
