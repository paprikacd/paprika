package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// An executable file (mode 100755) is checked out. go-git's FileMode.IsRegular
// is false for one, so checkoutTree skipped executables as if they were
// submodules: brandbrain's chart scripts never reached a render or the
// source hash.
func TestGitSourceResolve_ChecksOutExecutableFiles(t *testing.T) {
	_, origin, work := newOrigin(t)
	writeRepoFile(t, work, "chart/Chart.yaml", "name: demo\n")
	writeRepoFile(t, work, "chart/scripts/bump.sh", "#!/bin/sh\necho bump\n")
	if err := os.Chmod(filepath.Join(work, "chart/scripts/bump.sh"), 0o755); err != nil { // #nosec G302 -- an executable fixture
		t.Fatal(err)
	}
	commitAll(t, work, "chart")
	runGit(t, work, "push", "--quiet", "origin", "main")

	src := &GitSource{RepoURL: origin, Revision: "main", Path: "chart", WorkDir: t.TempDir(), Shallow: true}
	res, err := src.Resolve(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(res.LocalPath, "scripts", "bump.sh"))
	if err != nil {
		t.Fatalf("executable not checked out: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("checked out with mode %v, want it executable", info.Mode())
	}
}
