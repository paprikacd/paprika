//go:build e2e || bench

package source

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Benchmarks for the git resolve path on a synthetic monorepo. Built with a
// real git client (file:// origin) — run with:
//
//	go test -tags=bench ./internal/source -bench=GitSource -benchtime=1x
//
// The repo has many branches and a large file count so the fetch-refspec and
// materialization choices are measurable.

const (
	benchDirs      = 40
	benchFilesDir  = 25 // 40*25 = 1000 files
	benchBranches  = 20
	benchSparseDir = "services/service-08/deploy"
)

// benchMonorepo builds an origin with benchBranches branches and ~1000 files
// across benchDirs directories, returning the bare origin path.
func benchMonorepo(b *testing.B) string {
	b.Helper()
	root := b.TempDir()
	work := filepath.Join(root, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		b.Fatal(err)
	}
	runGitBench(b, work, "init", "--initial-branch=main")
	runGitBench(b, work, "-c", "user.email=bench@test", "-c", "user.name=bench", "commit", "--allow-empty", "-m", "init")
	for d := 0; d < benchDirs; d++ {
		var sub string
		if d%4 == 0 {
			sub = filepath.Join("services", fmt.Sprintf("service-%02d", d), "deploy")
		} else {
			sub = filepath.Join("modules", fmt.Sprintf("mod-%02d", d))
		}
		for f := 0; f < benchFilesDir; f++ {
			path := filepath.Join(work, sub, fmt.Sprintf("file-%02d.yaml", f))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				b.Fatal(err)
			}
			content := fmt.Sprintf("name: %s/%d\nindex: %d\n", sub, f, d*benchFilesDir+f)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				b.Fatal(err)
			}
		}
	}
	runGitBench(b, work, "add", ".")
	runGitBench(b, work, "-c", "user.email=bench@test", "-c", "user.name=bench", "commit", "-m", "files")
	for i := 0; i < benchBranches; i++ {
		runGitBench(b, work, "branch", fmt.Sprintf("release-%02d", i))
	}
	origin := filepath.Join(root, "origin.git")
	runGitBench(b, root, "clone", "--bare", "--no-hardlinks", work, origin)
	return origin
}

func runGitBench(b *testing.B, dir string, args ...string) {
	b.Helper()
	out, err := runGitCmd(dir, args...)
	if err != nil {
		b.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
}

// #nosec G204 -- benchmark helper invokes git with fixed arguments.
func runGitCmd(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

func BenchmarkGitSourceResolve_ColdFull(b *testing.B) {
	origin := benchMonorepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		src := &GitSource{RepoURL: origin, Revision: "main", WorkDir: b.TempDir(), Shallow: true}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		if _, err := src.Resolve(ctx); err != nil {
			cancel()
			b.Fatal(err)
		}
		cancel()
	}
}

func BenchmarkGitSourceResolve_ColdAllRefs(b *testing.B) {
	origin := benchMonorepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		src := &GitSource{RepoURL: origin, Revision: "main", WorkDir: b.TempDir(), Shallow: true, FetchAllRefs: true}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		if _, err := src.Resolve(ctx); err != nil {
			cancel()
			b.Fatal(err)
		}
		cancel()
	}
}

func BenchmarkGitSourceResolve_ColdSparse(b *testing.B) {
	origin := benchMonorepo(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		src := &GitSource{RepoURL: origin, Revision: "main", Path: benchSparseDir, WorkDir: b.TempDir(), Shallow: true}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		if _, err := src.Resolve(ctx); err != nil {
			cancel()
			b.Fatal(err)
		}
		cancel()
	}
}

func BenchmarkGitSourceResolve_Warm(b *testing.B) {
	origin := benchMonorepo(b)
	workDir := b.TempDir()
	src := &GitSource{RepoURL: origin, Revision: "main", Path: benchSparseDir, WorkDir: workDir, Shallow: true}
	ctx := context.Background()
	if _, err := src.Resolve(ctx); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := src.Resolve(ctx); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGitSourceResolve_PinnedSHA(b *testing.B) {
	origin := benchMonorepo(b)
	sha := gitOutputBench(b, origin, "rev-parse", "main")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		src := &GitSource{RepoURL: origin, Revision: sha, WorkDir: b.TempDir(), Shallow: true}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		if _, err := src.Resolve(ctx); err != nil {
			cancel()
			b.Fatal(err)
		}
		cancel()
	}
}

func gitOutputBench(b *testing.B, dir string, args ...string) string {
	b.Helper()
	out, err := runGitCmd(dir, args...)
	if err != nil {
		b.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}
