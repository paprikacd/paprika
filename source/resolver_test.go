package source

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSanitizeName(t *testing.T) {
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
		result := SanitizeName(tc.input)
		if result != tc.expected {
			t.Errorf("SanitizeName(%q) = %q, want %q", tc.input, result, tc.expected)
		}
	}
}

func TestComputeFileHash(t *testing.T) {
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
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("bbb"), 0o600); err != nil {
		t.Fatal(err)
	}

	hash, err := ComputeDirHash(dir)
	if err != nil {
		t.Fatalf("ComputeDirHash error: %v", err)
	}
	if hash == "" {
		t.Error("expected non-empty hash")
	}

	hash2, err := ComputeDirHash(dir)
	if err != nil {
		t.Fatalf("ComputeDirHash error: %v", err)
	}
	if hash != hash2 {
		t.Errorf("same dir should produce same hash: %s != %s", hash, hash2)
	}
}

func TestComputeDirHashDifferentContent(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0o600); err != nil {
		t.Fatal(err)
	}

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
}

func TestComputeDirHashEmpty(t *testing.T) {
	dir := t.TempDir()

	hash, err := ComputeDirHash(dir)
	if err != nil {
		t.Fatalf("ComputeDirHash on empty dir error: %v", err)
	}
	if hash == "" {
		t.Error("expected non-empty hash for empty dir")
	}
}

func TestGitSourceResolve_InvalidURL(t *testing.T) {
	g := &GitSource{
		RepoURL: "http://invalid-host-that-does-not-exist.example/repo.git",
		WorkDir: t.TempDir(),
	}
	_, err := g.Resolve(context.Background())
	if err == nil {
		t.Error("expected error for invalid git URL")
	}
}

func TestS3SourceResolve_InvalidEndpoint(t *testing.T) {
	s := &S3Source{
		Bucket:   "test-bucket",
		Key:      "chart.tgz",
		Region:   "us-east-1",
		Endpoint: "http://localhost:9999",
		WorkDir:  t.TempDir(),
	}
	_, err := s.Resolve(context.Background())
	if err == nil {
		t.Error("expected error for invalid S3 endpoint")
	}
}
