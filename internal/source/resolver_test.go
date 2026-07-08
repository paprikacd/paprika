package source

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSanitizeName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected string
	}{
		{"https://github.com/benebsworth/paprika", "https---github-com-benebsworth-paprika"},
		{"simple-repo", "simple-repo"},
		{"UPPERCASE", "---------"},
		{"repo.with.dots", "repo-with-dots"},
		{"my/bucket/name", "my-bucket-name"},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			result := SanitizeName(tc.input)
			if result != tc.expected {
				t.Errorf("SanitizeName(%q) = %q, want %q", tc.input, result, tc.expected)
			}
		})
	}
}

func TestComputeFileHash(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	f := filepath.Join(dir, "testfile")
	if err := os.WriteFile(f, []byte("hello world"), 0o600); err != nil {
		t.Fatal(err)
	}

	hash, err := ComputeFileHash(f)
	if err != nil {
		t.Fatalf("ComputeFileHash error: %v", err)
	}
	if hash == "" {
		t.Error("expected non-empty hash")
	}

	hash2, err := ComputeFileHash(f)
	if err != nil {
		t.Fatalf("ComputeFileHash error: %v", err)
	}
	if hash != hash2 {
		t.Errorf("same file should produce same hash: %s != %s", hash, hash2)
	}
}

func TestComputeDirHash(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		prepare func(t *testing.T, dir string)
		check   func(t *testing.T, dir string)
	}{
		{
			name: "consistent for same directory",
			prepare: func(t *testing.T, dir string) {
				if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("bbb"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			check: func(t *testing.T, dir string) {
				hash1, err := ComputeDirHash(dir)
				if err != nil {
					t.Fatalf("ComputeDirHash error: %v", err)
				}
				if hash1 == "" {
					t.Error("expected non-empty hash")
				}
				hash2, err := ComputeDirHash(dir)
				if err != nil {
					t.Fatalf("ComputeDirHash error: %v", err)
				}
				if hash1 != hash2 {
					t.Errorf("same dir should produce same hash: %s != %s", hash1, hash2)
				}
			},
		},
		{
			name: "different content produces different hash",
			prepare: func(t *testing.T, dir string) {
				if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			check: func(t *testing.T, dir string) {
				hash1, err := ComputeDirHash(dir)
				if err != nil {
					t.Fatal(err)
				}
				if writeErr := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("bbb"), 0o600); writeErr != nil {
					t.Fatal(writeErr)
				}
				hash2, err := ComputeDirHash(dir)
				if err != nil {
					t.Fatal(err)
				}
				if hash1 == hash2 {
					t.Error("different content should produce different hashes")
				}
			},
		},
		{
			name: "empty directory",
			check: func(t *testing.T, dir string) {
				hash, err := ComputeDirHash(dir)
				if err != nil {
					t.Fatalf("ComputeDirHash on empty dir error: %v", err)
				}
				if hash == "" {
					t.Error("expected non-empty hash for empty dir")
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			if tc.prepare != nil {
				tc.prepare(t, dir)
			}
			tc.check(t, dir)
		})
	}
}

func TestSourceResolve_Invalid(t *testing.T) {
	t.Parallel()

	type resolver interface {
		Resolve(context.Context) (*ResolveResult, error)
	}

	tests := []struct {
		name string
		src  resolver
	}{
		{
			name: "git invalid URL",
			src: &GitSource{
				RepoURL: "http://invalid-host-that-does-not-exist.example/repo.git",
				WorkDir: t.TempDir(),
			},
		},
		{
			name: "s3 invalid endpoint",
			src: &S3Source{
				Bucket:   "test-bucket",
				Key:      "chart.tgz",
				Region:   "us-east-1",
				Endpoint: "http://localhost:9999",
				WorkDir:  t.TempDir(),
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if _, err := tc.src.Resolve(context.Background()); err == nil {
				t.Errorf("%s: expected error for invalid source", tc.name)
			}
		})
	}
}

func TestGitSourceResolve_TracksUpdatedBranch(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	work := filepath.Join(root, "work")
	resolverWorkDir := filepath.Join(root, "resolver")

	runGit(t, root, "init", "--bare", "--initial-branch=master", origin)
	runGit(t, root, "init", "--initial-branch=master", work)
	runGit(t, work, "config", "user.email", "test@example.com")
	runGit(t, work, "config", "user.name", "Test User")
	runGit(t, work, "remote", "add", "origin", origin)

	writeChartFile(t, work, "first")
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "first")
	runGit(t, work, "push", "-u", "origin", "master")

	src := &GitSource{
		RepoURL:  origin,
		Revision: "master",
		Path:     "chart",
		WorkDir:  resolverWorkDir,
	}

	first, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("first Resolve() error: %v", err)
	}

	writeChartFile(t, work, "second")
	runGit(t, work, "add", ".")
	runGit(t, work, "commit", "-m", "second")
	runGit(t, work, "push", "origin", "master")

	second, err := src.Resolve(ctx)
	if err != nil {
		t.Fatalf("second Resolve() error: %v", err)
	}

	if second.Revision == first.Revision {
		t.Fatalf("expected second resolve to track updated master, got same revision %s", second.Revision)
	}

	got, err := os.ReadFile(filepath.Join(second.LocalPath, "values.yaml"))
	if err != nil {
		t.Fatalf("read resolved chart file: %v", err)
	}
	if string(got) != "version: second\n" {
		t.Fatalf("resolved chart content = %q, want updated branch content", string(got))
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// #nosec G204 -- test helper invokes git with fixed arguments from each test case.
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func writeChartFile(t *testing.T, dir, version string) {
	t.Helper()

	chartDir := filepath.Join(dir, "chart")
	if err := os.MkdirAll(chartDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chartDir, "values.yaml"), []byte("version: "+version+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}
