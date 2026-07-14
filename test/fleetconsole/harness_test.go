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
