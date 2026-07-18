package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFleetConsoleHarnessNeverWritesRejectedOutputDirectory(t *testing.T) {
	rejected := filepath.Join(t.TempDir(), "rejected")
	assertHarnessRejectsOutputDirectory(t, rejected)
	_, statErr := os.Stat(rejected)
	require.True(t, errors.Is(statErr, os.ErrNotExist),
		"rejected output path must remain absent, got %v", statErr)
}

func TestFleetConsoleHarnessRejectsAllowedLookingSymlinkOutsideBoundary(t *testing.T) {
	external := t.TempDir()
	allowedRoot := filepath.Join("..", "..", "ui", "test-results")
	require.NoError(t, os.MkdirAll(allowedRoot, 0o750))
	link := filepath.Join(allowedRoot, "rejected-symlink-"+filepath.Base(external))
	require.NoError(t, os.Symlink(external, link))
	t.Cleanup(func() { require.NoError(t, os.Remove(link)) })

	assertHarnessRejectsOutputDirectory(t, filepath.Join(link, "artifacts"))
	entries, err := os.ReadDir(external)
	require.NoError(t, err)
	require.Empty(t, entries, "rejected symlink target must receive no artifacts")
}

func TestFleetConsoleHarnessDefaultsReviewedAdminSessionStubForPlaywright(t *testing.T) {
	script, err := os.ReadFile("../../hack/test-fleet-console.sh")
	require.NoError(t, err)

	const (
		playwrightBlockStart = "PLAYWRIGHT_NO_WEBSERVER=1 \\\n"
		playwrightCommand    = "npm --prefix "
		assignmentPrefix     = "PAPRIKA_E2E_ADMIN_SESSION_STUB="
		expectedAssignment   = `PAPRIKA_E2E_ADMIN_SESSION_STUB="${PAPRIKA_E2E_ADMIN_SESSION_STUB:-1}"`
	)
	blockStart := strings.LastIndex(string(script), playwrightBlockStart)
	require.NotEqual(t, -1, blockStart, "Playwright environment block is missing")
	commandOffset := strings.Index(string(script)[blockStart:], playwrightCommand)
	require.NotEqual(t, -1, commandOffset, "Playwright command is missing")
	playwrightBlock := string(script)[blockStart : blockStart+commandOffset]

	var assignment string
	for line := range strings.SplitSeq(playwrightBlock, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), `\`))
		if strings.HasPrefix(line, assignmentPrefix) {
			assignment = line
			break
		}
	}
	require.Equal(t, expectedAssignment, assignment,
		"local Playwright must use a reviewed admin-session stub unless explicitly disabled")

	for _, testCase := range []struct {
		name      string
		inherited *string
		want      string
	}{
		{name: "defaults unset value to one", want: "1"},
		{name: "preserves explicit zero", inherited: ptr("0"), want: "0"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			command := exec.CommandContext(t.Context(), "bash", "-c",
				`PAPRIKA_E2E_ADMIN_SESSION_STUB="${PAPRIKA_E2E_ADMIN_SESSION_STUB:-1}"; `+
					`printf '%s' "${PAPRIKA_E2E_ADMIN_SESSION_STUB}"`)
			command.Env = withoutEnvironmentVariable(os.Environ(), "PAPRIKA_E2E_ADMIN_SESSION_STUB")
			if testCase.inherited != nil {
				command.Env = append(command.Env,
					"PAPRIKA_E2E_ADMIN_SESSION_STUB="+*testCase.inherited)
			}
			output, runErr := command.CombinedOutput()
			require.NoError(t, runErr, "assignment failed: %s", output)
			require.Equal(t, testCase.want, string(output))
		})
	}
}

func assertHarnessRejectsOutputDirectory(t *testing.T, rejected string) {
	t.Helper()

	command := exec.CommandContext(t.Context(), "bash", "../../hack/test-fleet-console.sh")
	command.Env = append(os.Environ(), "PAPRIKA_E2E_OUTPUT_DIR="+rejected)
	output, err := command.CombinedOutput()

	require.Error(t, err)
	require.True(t, strings.Contains(string(output),
		"PAPRIKA_E2E_OUTPUT_DIR must stay under ui/test-results or output/playwright"),
		"unexpected harness output: %s", output)
}

func withoutEnvironmentVariable(environment []string, name string) []string {
	prefix := name + "="
	filtered := make([]string, 0, len(environment))
	for _, value := range environment {
		if !strings.HasPrefix(value, prefix) {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func ptr(value string) *string {
	return &value
}
