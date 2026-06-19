package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"
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
