package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights"
)

// invalidDashboardJSON is a dashboard from a newer schema, which startup quarantines rather than serves.
const invalidDashboardJSON = `{"schemaVersion":2,"id":"broken"}`

func writeInvalidDashboard(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "broken.json")
	require.NoError(t, os.WriteFile(path, []byte(invalidDashboardJSON), 0o600))
	return path
}

// A listen address that is already taken stops startup before the store is read, so the invalid document stays in
// place and nothing enters quarantine.
func TestOpenServiceTakenPortMovesNothing(t *testing.T) {
	var lc net.ListenConfig
	taken, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = taken.Close() })
	dir := t.TempDir()
	broken := writeInvalidDashboard(t, dir)

	_, listener, err := openService(taken.Addr().String(), dir, insights.Config{InsecureDev: true})
	require.ErrorContains(t, err, "listen Insights")
	require.Nil(t, listener)
	require.FileExists(t, broken, "a failed listen must leave the invalid document in place")
	require.NoDirExists(t, filepath.Join(dir, "quarantine"))
}

// An address that cannot be parsed fails the same way.
func TestOpenServiceBadAddressMovesNothing(t *testing.T) {
	dir := t.TempDir()
	broken := writeInvalidDashboard(t, dir)

	_, listener, err := openService("127.0.0.1:99999", dir, insights.Config{InsecureDev: true})
	require.ErrorContains(t, err, "listen Insights")
	require.Nil(t, listener)
	require.FileExists(t, broken)
	require.NoDirExists(t, filepath.Join(dir, "quarantine"))
}

// A successful startup binds, commits the quarantine, and hands back the bound listener for serving.
func TestOpenServiceCommitsQuarantineAfterBinding(t *testing.T) {
	dir := t.TempDir()
	broken := writeInvalidDashboard(t, dir)

	service, listener, err := openService("127.0.0.1:0", dir, insights.Config{InsecureDev: true})
	require.NoError(t, err)
	t.Cleanup(func() { _ = listener.Close() })
	require.NotNil(t, service)
	require.NotNil(t, listener)
	require.NoFileExists(t, broken, "a successful startup moves the invalid document")
	copies, err := os.ReadDir(filepath.Join(dir, "quarantine", "dashboard"))
	require.NoError(t, err)
	require.Len(t, copies, 1)
}
