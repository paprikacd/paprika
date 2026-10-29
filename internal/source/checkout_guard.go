package source

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Both backends write a repository's files to disk for Helm and Kustomize to
// read, and a chart's .Files can read anything a symlink in it reaches. So a
// checkout never holds a symlink that resolves outside its root, never writes
// an entry beneath a symlinked directory, and never writes through an
// existing path. Git trees never hold a path beneath a symlink on a
// case-sensitive filesystem, but on a case-insensitive one a symlink "A" and
// a file "a/x" alias, and a hostile server can send any tree.

// checkSymlinkTarget refuses, before writing it, the symlink name -> link
// whose target is empty, absolute or leaves the root lexically.
// verifySymlinks checks what each link resolves to once every entry exists.
func checkSymlinkTarget(name, link string) error {
	resolved := path.Join(path.Dir(name), link)
	if link == "" || path.IsAbs(link) || filepath.IsAbs(link) || resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("checkout tree: symlink %s points outside the source path (%q)", name, link)
	}
	return nil
}

// checkoutGuard refuses writes beneath a symlinked directory of one checkout.
type checkoutGuard struct {
	root string
	// dirs holds the directories found to be real directories. A symlink
	// cannot later appear at one of them: creating it fails.
	dirs map[string]bool
}

func newCheckoutGuard(root string) *checkoutGuard {
	return &checkoutGuard{root: root, dirs: map[string]bool{}}
}

// parentsOK reports an error when a directory above the entry rel (slash
// separated, relative to the root) is a symlink or not a directory.
func (g *checkoutGuard) parentsOK(rel string) error {
	dir := path.Dir(rel)
	if dir == "." {
		return nil
	}
	prefix := ""
	for _, name := range strings.Split(dir, "/") {
		prefix = path.Join(prefix, name)
		if g.dirs[prefix] {
			continue
		}
		info, err := os.Lstat(filepath.Join(g.root, filepath.FromSlash(prefix)))
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil // created as a real directory by the write
		case err != nil:
			return fmt.Errorf("checkout tree: %s: %w", rel, err)
		case info.Mode()&fs.ModeSymlink != 0:
			return fmt.Errorf("checkout tree: %s is beneath the symlink %s", rel, prefix)
		case !info.IsDir():
			return fmt.Errorf("checkout tree: %s is beneath the file %s", rel, prefix)
		}
		g.dirs[prefix] = true
	}
	return nil
}

// verifySymlinks resolves every symlink under root and refuses one that
// resolves outside root, dangles or loops. A link can pass checkSymlinkTarget
// and still escape through another link: "s" -> "." at the root makes
// "x" -> "s/../secret" read root/../secret.
func verifySymlinks(root string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("checkout tree: resolve %s: %w", root, err)
	}
	//nolint:wrapcheck // the callback's errors are wrapped where they arise
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error { // #nosec G703 -- root is this package's own checkout
		if walkErr != nil {
			return fmt.Errorf("checkout tree: walk %s: %w", p, walkErr)
		}
		if d.Type()&fs.ModeSymlink == 0 {
			return nil
		}
		name, _ := filepath.Rel(root, p) //nolint:errcheck // p is under root
		target, err := filepath.EvalSymlinks(p)
		if err != nil {
			return fmt.Errorf("checkout tree: symlink %s does not resolve inside the source path: %w", filepath.ToSlash(name), err)
		}
		if rel, err := filepath.Rel(realRoot, target); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("checkout tree: symlink %s resolves outside the source path", filepath.ToSlash(name))
		}
		return nil
	})
}

// createFile creates a new file for a checkout entry. O_EXCL never writes
// through, or over, an existing path: a symlink there makes it fail.
func createFile(target string, perm os.FileMode) (*os.File, error) {
	// #nosec G304 -- target is a validated tree path under our checkout dir.
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return nil, fmt.Errorf("checkout tree: create %s: %w", target, err)
	}
	return f, nil
}
