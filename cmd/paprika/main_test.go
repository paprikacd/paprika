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
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/version"
)

func TestVersionReportsDevelopmentDefault(t *testing.T) {
	stdout := executeRootCommand(t, "version")

	if !strings.Contains(stdout, "paprika client: dev") {
		t.Fatalf("version output = %q, want client dev line", stdout)
	}
	if !strings.Contains(stdout, "paprika server: unavailable") {
		t.Fatalf("version output = %q, want a server line (no server configured in test)", stdout)
	}
}

func TestVersionReportsInjectedBuildMetadata(t *testing.T) {
	setBuildMetadata(t, "v1.2.3", "abc1234def", "2026-08-13T04:05:06Z")

	stdout := executeRootCommand(t, "version")

	want := "paprika client: v1.2.3  (commit=abc1234def built=2026-08-13T04:05:06Z)"
	if !strings.Contains(stdout, want) {
		t.Fatalf("version output = %q, want substring %q", stdout, want)
	}
}

func TestRootRegistersLoginStatusAndVersionCommands(t *testing.T) {
	preserveCLIFlagState(t)
	root := newRootCmd(context.Background())
	for _, name := range []string{"login", "status", "version"} {
		command, _, err := root.Find([]string{name})
		if err != nil {
			t.Fatalf("find %s command: %v", name, err)
		}
		if command == nil || command.Name() != name {
			t.Errorf("root %s command = %#v, want registered %s command", name, command, name)
		}
	}
}

func TestRootCommandExecutionRestoresGlobalFlagState(t *testing.T) {
	original := currentCLIFlagState()
	t.Cleanup(func() { setCLIFlagState(original) })
	want := cliFlagState{
		configPath: "config-before-test",
		server:     "server-before-test",
		namespace:  "namespace-before-test",
		username:   "username-before-test",
		password:   "password-before-test",
		token:      "token-before-test",
		output:     "output-before-test",
	}
	setCLIFlagState(want)

	t.Run("version", func(t *testing.T) {
		executeRootCommand(t, "version")
	})

	if got := currentCLIFlagState(); got != want {
		t.Fatalf("CLI flag state after command = %#v, want %#v", got, want)
	}
}

// version contacts the server to print its build identity too, but an
// unreachable or unconfigured server must degrade gracefully — never fail
// or hide the client version.
func TestVersionDegradesGracefullyWithoutConfig(t *testing.T) {
	invalidConfigPath := t.TempDir()
	if _, err := loadConfig(invalidConfigPath); err == nil {
		t.Fatalf("loadConfig(%q) unexpectedly succeeded; test requires an invalid config path", invalidConfigPath)
	}

	got := executeRootCommand(t, "--config", invalidConfigPath, "version")
	if !strings.Contains(got, "paprika client: dev") {
		t.Fatalf("version output = %q, want client line", got)
	}
	if !strings.Contains(got, "paprika server: unavailable") {
		t.Fatalf("version output = %q, want graceful server line", got)
	}
}

func TestVersionDegradesGracefullyWithoutEnvironment(t *testing.T) {
	preserveCLIFlagState(t)
	var stdout bytes.Buffer
	root := newRootCmdWithEnv(context.Background(), func(string) string { return "" })
	root.SetArgs([]string{"version"})
	root.SetOut(&stdout)
	root.SetErr(&bytes.Buffer{})

	if err := root.Execute(); err != nil {
		t.Fatalf("execute paprika version: %v", err)
	}
	if got := stdout.String(); !strings.Contains(got, "paprika client:") {
		t.Fatalf("version output = %q, want client line", got)
	}
}

func executeRootCommand(t *testing.T, args ...string) string {
	t.Helper()
	preserveCLIFlagState(t)
	var stdout bytes.Buffer
	root := newRootCmd(context.Background())
	root.SetArgs(args)
	root.SetOut(&stdout)
	root.SetErr(&bytes.Buffer{})
	if err := root.Execute(); err != nil {
		t.Fatalf("execute paprika %s: %v", strings.Join(args, " "), err)
	}
	return stdout.String()
}

func setBuildMetadata(t *testing.T, buildVersion, buildCommit, buildDate string) {
	t.Helper()
	previousVersion, previousCommit, previousDate := version.Version, version.Commit, version.Date
	version.Version, version.Commit, version.Date = buildVersion, buildCommit, buildDate
	t.Cleanup(func() {
		version.Version, version.Commit, version.Date = previousVersion, previousCommit, previousDate
	})
}

type cliFlagState struct {
	configPath string
	server     string
	namespace  string
	username   string
	password   string
	token      string
	output     string
}

func currentCLIFlagState() cliFlagState {
	return cliFlagState{
		configPath: globalConfigPath,
		server:     globalServer,
		namespace:  globalNamespace,
		username:   globalUsername,
		password:   globalPassword,
		token:      globalToken,
		output:     globalOutput,
	}
}

func setCLIFlagState(state cliFlagState) {
	globalConfigPath = state.configPath
	globalServer = state.server
	globalNamespace = state.namespace
	globalUsername = state.username
	globalPassword = state.password
	globalToken = state.token
	globalOutput = state.output
}

func preserveCLIFlagState(t *testing.T) {
	t.Helper()
	state := currentCLIFlagState()
	t.Cleanup(func() { setCLIFlagState(state) })
}
