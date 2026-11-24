package main

import (
	"context"
	"net"
	"net/http"
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

// The metrics listener serves /metrics and no API route, so a scraper admitted to its port cannot reach /api.
func TestMetricsServerServesOnlyMetrics(t *testing.T) {
	service, listener, err := openService("127.0.0.1:0", t.TempDir(), insights.Config{Token: "0123456789abcdef0123456789abcdef"})
	require.NoError(t, err)
	require.NoError(t, listener.Close())
	metricsListener, err := listenMetrics("127.0.0.1:0")
	require.NoError(t, err)
	server := newMetricsServer(service)
	go func() { _ = server.Serve(metricsListener) }()
	t.Cleanup(func() { _ = server.Close() })
	base := "http://" + metricsListener.Addr().String()
	for path, want := range map[string]int{"/metrics": http.StatusOK, "/api/providers": http.StatusNotFound, "/api/query": http.StatusNotFound, "/healthz": http.StatusNotFound} {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, base+path, nil)
		require.NoError(t, err)
		request.Header.Set("Authorization", "Bearer 0123456789abcdef0123456789abcdef")
		response, err := http.DefaultClient.Do(request)
		require.NoError(t, err)
		_ = response.Body.Close()
		require.Equal(t, want, response.StatusCode, path)
	}
}

// An empty metrics address binds nothing; an invalid one stops startup.
func TestListenMetrics(t *testing.T) {
	listener, err := listenMetrics("")
	require.NoError(t, err)
	require.Nil(t, listener)
	_, err = listenMetrics("127.0.0.1:99999")
	require.ErrorContains(t, err, "listen Insights metrics")
}
