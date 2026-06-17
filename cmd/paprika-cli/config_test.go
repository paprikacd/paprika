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
	"os"
	"path/filepath"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg := &Config{
		Server:    "http://localhost:3000",
		Namespace: "paprika-system",
		Username:  "admin",
		Password:  "changeme",
		Token:     "",
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
