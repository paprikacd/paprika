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
)

func TestVersionReportsDevelopmentDefault(t *testing.T) {
	stdout := executeRootCommand(t, "version")

	if stdout != "paprika dev\n" {
		t.Fatalf("version output = %q, want %q", stdout, "paprika dev\n")
	}
}

func TestVersionReportsInjectedBuildMetadata(t *testing.T) {
	setBuildMetadata(t, "v1.2.3", "abc123", "2026-08-13T04:05:06Z")

	stdout := executeRootCommand(t, "version")

	want := "paprika v1.2.3\ncommit=abc123 date=2026-08-13T04:05:06Z\n"
	if stdout != want {
		t.Fatalf("version output = %q, want %q", stdout, want)
	}
}

func TestRootRegistersLoginStatusAndVersionCommands(t *testing.T) {
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

func TestVersionDoesNotLoadEnvironmentOrConfig(t *testing.T) {
	var stdout bytes.Buffer
	err := run(
		context.Background(),
		[]string{"--config", t.TempDir(), "version"},
		func(string) string { panic("version unexpectedly loaded the environment") },
		strings.NewReader(""),
		&stdout,
		&bytes.Buffer{},
	)
	if err != nil {
		t.Fatalf("run version with unreadable config path: %v", err)
	}
	if got := stdout.String(); got != "paprika dev\n" {
		t.Fatalf("version output = %q, want %q", got, "paprika dev\n")
	}
}

func executeRootCommand(t *testing.T, args ...string) string {
	t.Helper()
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
	previousVersion, previousCommit, previousDate := version, commit, date
	version, commit, date = buildVersion, buildCommit, buildDate
	t.Cleanup(func() {
		version, commit, date = previousVersion, previousCommit, previousDate
	})
}
