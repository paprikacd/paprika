/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg := &Config{
		Server:         "http://localhost:3000",
		Namespace:      "paprika-system",
		Username:       "admin",
		Password:       "changeme",
		Token:          "access-token",
		TokenExpiresAt: time.Date(2026, time.August, 12, 9, 30, 0, 0, time.UTC),
	}

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save config: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("expected config file mode 0600, got %o", info.Mode().Perm())
	}

	loaded, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if loaded.Server != cfg.Server {
		t.Errorf("server mismatch: got %q, want %q", loaded.Server, cfg.Server)
	}
	if loaded.Namespace != cfg.Namespace {
		t.Errorf("namespace mismatch: got %q, want %q", loaded.Namespace, cfg.Namespace)
	}
	if loaded.Username != cfg.Username {
		t.Errorf("username mismatch: got %q, want %q", loaded.Username, cfg.Username)
	}
	if loaded.Password != cfg.Password {
		t.Errorf("password mismatch: got %q, want %q", loaded.Password, cfg.Password)
	}
	if loaded.Token != cfg.Token {
		t.Errorf("token mismatch: got %q, want %q", loaded.Token, cfg.Token)
	}
	if !loaded.TokenExpiresAt.Equal(cfg.TokenExpiresAt) {
		t.Errorf("token expiry mismatch: got %s, want %s", loaded.TokenExpiresAt, cfg.TokenExpiresAt)
	}

	//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), "tokenExpiresAt: 2026-08-12T09:30:00Z") {
		t.Errorf("config does not contain tokenExpiresAt YAML field:\n%s", data)
	}
}

func TestConfigSavePreservesExistingFieldsWhenUpdatingToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := &Config{
		Server:    "https://paprika.example.com",
		Namespace: "production",
		Username:  "operator",
		Password:  "secret",
	}
	if err := original.Save(path); err != nil {
		t.Fatalf("save original config: %v", err)
	}

	updated, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load original config: %v", err)
	}
	updated.Token = "new-access-token"
	updated.TokenExpiresAt = time.Date(2026, time.August, 12, 10, 0, 0, 0, time.UTC)
	if saveErr := updated.Save(path); saveErr != nil {
		t.Fatalf("save updated config: %v", saveErr)
	}

	got, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load updated config: %v", err)
	}
	if !reflect.DeepEqual(got, updated) {
		t.Errorf("updated config mismatch:\n got: %#v\nwant: %#v", got, updated)
	}
	assertOnlyConfigFile(t, dir, path)
}

func TestConfigSaveAtomicallyReplacesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := []byte("server: https://old.example.com\n")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatalf("write original config: %v", err)
	}

	wantErr := errors.New("injected rename failure")
	renameFile := func(oldPath, newPath string) error {
		if newPath != path {
			t.Errorf("rename destination = %q, want %q", newPath, path)
		}
		//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read destination during rename: %v", err)
		}
		if !reflect.DeepEqual(data, original) {
			t.Errorf("destination changed before rename: got %q, want %q", data, original)
		}
		return wantErr
	}

	err := (&Config{Server: "https://new.example.com"}).save(path, renameFile)
	if !errors.Is(err, wantErr) {
		t.Fatalf("Save() error = %v, want wrapped %v", err, wantErr)
	}
	//nolint:gosec // path is rooted in t.TempDir and controlled by this test.
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read original config after failed save: %v", readErr)
	}
	if !reflect.DeepEqual(got, original) {
		t.Errorf("original config changed after failed save: got %q, want %q", got, original)
	}
	assertOnlyConfigFile(t, dir, path)
}

func TestConfigSaveCorrectsExistingPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	//nolint:gosec // deliberately create an overly permissive file to verify Save corrects it.
	if err := os.WriteFile(path, []byte("server: https://old.example.com\n"), 0o644); err != nil {
		t.Fatalf("write original config: %v", err)
	}

	if err := (&Config{Server: "https://new.example.com"}).Save(path); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("config mode = %o, want 600", got)
	}
	assertOnlyConfigFile(t, dir, path)
}

func TestConfigSaveDoesNotChmodPathAfterRename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	sentinelPath := filepath.Join(t.TempDir(), "sentinel")
	if err := os.WriteFile(sentinelPath, []byte("do not modify"), 0o400); err != nil {
		t.Fatalf("write sentinel: %v", err)
	}

	renameFile := func(oldPath, newPath string) error {
		// #nosec G703 -- oldPath is produced by os.CreateTemp in the test's t.TempDir.
		info, err := os.Stat(oldPath)
		if err != nil {
			t.Fatalf("stat temporary config before rename: %v", err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("temporary config mode before rename = %o, want 600", got)
		}
		// #nosec G703 -- both paths are confined to the test's t.TempDir.
		if err := os.Rename(oldPath, newPath); err != nil {
			return err
		}
		if err := os.Remove(newPath); err != nil {
			t.Fatalf("replace renamed config: %v", err)
		}
		if err := os.Symlink(sentinelPath, newPath); err != nil {
			t.Fatalf("symlink replacement target: %v", err)
		}
		return nil
	}

	if err := (&Config{Server: "https://paprika.example.com"}).save(path, renameFile); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(sentinelPath)
	if err != nil {
		t.Fatalf("stat sentinel: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o400 {
		t.Errorf("replacement target mode = %o, want unchanged 400", got)
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	cfg, err := loadConfig(filepath.Join(t.TempDir(), "notfound.yaml"))
	if err != nil {
		t.Fatalf("expected no error for missing file: %v", err)
	}
	if cfg.Server != "" {
		t.Errorf("expected empty config, got server %q", cfg.Server)
	}
}

func assertOnlyConfigFile(t *testing.T, dir, configPath string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read config directory: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(configPath) {
		t.Fatalf("config directory entries = %v, want only %q", entries, filepath.Base(configPath))
	}
}
