// Package source provides source resolution for git, S3, and other sources.
package source

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ResolveResult contains the result of resolving a source.
type ResolveResult struct {
	LocalPath string
	Hash      string
	Revision  string
}

// ComputeFileHash computes the SHA256 hash of a file.
func ComputeFileHash(path string) (string, error) {
	// #nosec G304 -- path is from internal source resolution
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open file for hashing: %w", err)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		if closeErr := f.Close(); closeErr != nil {
			return "", fmt.Errorf("hash file: %w", errors.Join(err, closeErr))
		}
		return "", fmt.Errorf("hash file: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("close file after hashing: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ComputeDirHash computes the SHA256 hash of all files in a directory.
func ComputeDirHash(dir string) (string, error) {
	h := sha256.New()
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return fmt.Errorf("walk path %q: %w", path, err)
		}
		if skip, skipErr := skipDirHashEntry(info); skip || skipErr != nil {
			return skipErr
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return fmt.Errorf("compute relative path: %w", relErr)
		}
		h.Write([]byte(rel))
		// #nosec G304,G122 -- path is from internal directory walk, no symlink traversal concern
		f, openErr := os.Open(path)
		if openErr != nil {
			return fmt.Errorf("open file for dir hash: %w", openErr)
		}
		if _, copyErr := io.Copy(h, f); copyErr != nil {
			if closeErr := f.Close(); closeErr != nil {
				return fmt.Errorf("copy file content for dir hash: %w", errors.Join(copyErr, closeErr))
			}
			return fmt.Errorf("copy file content for dir hash: %w", copyErr)
		}
		if closeErr := f.Close(); closeErr != nil {
			return fmt.Errorf("close file after dir hash: %w", closeErr)
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("hash directory: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func skipDirHashEntry(info os.FileInfo) (bool, error) {
	if info.Name() == ".git" {
		if info.IsDir() {
			return true, filepath.SkipDir
		}
		return true, nil
	}
	return info.IsDir(), nil
}

// SanitizeName sanitizes a string for use in file paths.
func SanitizeName(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			result = append(result, c)
		} else {
			result = append(result, '-')
		}
	}
	return string(result)
}
