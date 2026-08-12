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
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// Config holds CLI configuration stored in ~/.paprika/config.yaml.
type Config struct {
	Server         string    `yaml:"server"`
	Namespace      string    `yaml:"namespace,omitempty"`
	Username       string    `yaml:"username,omitempty"`
	Password       string    `yaml:"password,omitempty"` //nolint:gosec // CLI config intentionally persists Basic credentials at mode 0600.
	Token          string    `yaml:"token,omitempty"`
	TokenExpiresAt time.Time `yaml:"tokenExpiresAt,omitempty"`
}

var renameConfigFile = os.Rename

func configDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".paprika")
}

func defaultConfigPath() string {
	return filepath.Join(configDir(), "config.yaml")
}

func loadConfig(path string) (*Config, error) {
	//nolint:gosec // path comes from defaultConfigPath or user config flag
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &cfg, nil
}

func (c *Config) Save(path string) (saveErr error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	// #nosec G117 -- config file intentionally stores CLI credentials in the user's home directory with 0600 permissions.
	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	tmpPath := tmp.Name()
	tmpClosed := false
	tmpRenamed := false
	defer func() {
		saveErr = cleanupConfigTempFile(tmp, tmpPath, tmpClosed, tmpRenamed, saveErr)
	}()

	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("set temporary config permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temporary config: %w", err)
	}
	tmpClosed = true
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := renameConfigFile(tmpPath, path); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	tmpRenamed = true
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("set config permissions: %w", err)
	}
	return nil
}

func cleanupConfigTempFile(tmp *os.File, path string, closed, renamed bool, saveErr error) error {
	if !closed {
		if err := tmp.Close(); err != nil {
			saveErr = errors.Join(saveErr, fmt.Errorf("close temporary config: %w", err))
		}
	}
	if !renamed {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			saveErr = errors.Join(saveErr, fmt.Errorf("remove temporary config: %w", err))
		}
	}
	return saveErr
}
