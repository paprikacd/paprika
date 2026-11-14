package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// quarantineMetrics installs a manual reader as the global meter provider for one test.
func quarantineMetrics(t *testing.T) *sdkmetric.ManualReader {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previous)
		_ = provider.Shutdown(context.Background())
	})
	return reader
}

// quarantinedTotal sums paprika_insights_store_quarantined for one kind.
func quarantinedTotal(t *testing.T, reader *sdkmetric.ManualReader, kind string) int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	require.NoError(t, reader.Collect(t.Context(), &rm))
	var total int64
	for _, scope := range rm.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "paprika_insights_store_quarantined" {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			require.True(t, ok)
			for _, point := range sum.DataPoints {
				if got, _ := point.Attributes.Value(attribute.Key("kind")); got.AsString() == kind {
					total += point.Value
				}
			}
		}
	}
	return total
}

// captureLogs routes the default slog logger into a buffer for one test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

// quarantinedFiles lists the quarantined copies of one document, relative to the quarantine kind directory.
func quarantinedFiles(t *testing.T, root, kind, id string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "quarantine", kind))
	if os.IsNotExist(err) {
		return nil
	}
	require.NoError(t, err)
	var names []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), id+".") && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	return names
}

func writeStoredFile(t *testing.T, path string, data []byte) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, data, 0o600))
}

func storedIDs(store *Store) []string {
	documents := store.List()
	ids := make([]string, 0, len(documents))
	for _, document := range documents {
		var fields struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(document, &fields)
		ids = append(ids, fields.ID)
	}
	slices.Sort(ids)
	return ids
}

// A store holding one valid and one invalid dashboard opens. The invalid file moves into quarantine, the counter
// increments, and the warning names the kind, the id and the reason.
func TestOpenStoreQuarantinesInvalidDashboardAndOpens(t *testing.T) {
	dir := t.TempDir()
	healthy := storedDashboardDocument(t, "healthy", nil)
	broken := storedDashboardDocument(t, "broken", map[string]any{"timeRange": "bogus"})
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), healthy)
	writeStoredFile(t, filepath.Join(dir, "broken.json"), broken)
	reader := quarantineMetrics(t)
	logs := captureLogs(t)

	store, err := OpenStore(dir)
	require.NoError(t, err, "one invalid document must not stop the store from opening")

	require.Equal(t, []string{"healthy"}, storedIDs(store))
	_, _, err = store.Get("broken")
	require.ErrorIs(t, err, ErrNotFound)
	require.NoFileExists(t, filepath.Join(dir, "broken.json"))

	copies := quarantinedFiles(t, dir, "dashboard", "broken")
	require.Len(t, copies, 1, "exactly one quarantined copy")
	kept, err := os.ReadFile(filepath.Join(dir, "quarantine", "dashboard", copies[0])) //nolint:gosec // The test reads a copy it just created under t.TempDir.
	require.NoError(t, err)
	require.JSONEq(t, string(broken), string(kept), "the quarantined copy is the original bytes")

	require.Equal(t, int64(1), quarantinedTotal(t, reader, "dashboard"))
	require.Contains(t, logs.String(), "level=WARN")
	require.Contains(t, logs.String(), "kind=dashboard")
	require.Contains(t, logs.String(), "id=broken")
	require.Contains(t, logs.String(), "reason=")
}

// A second start finds nothing left to quarantine: the counter, the copies and the warnings do not change.
func TestQuarantineIsIdempotentAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", nil))
	writeStoredFile(t, filepath.Join(dir, "broken.json"), storedDashboardDocument(t, "broken", map[string]any{"timeRange": "bogus"}))
	reader := quarantineMetrics(t)

	_, err := OpenStore(dir)
	require.NoError(t, err)
	logs := captureLogs(t)
	reopened, err := OpenStore(dir)
	require.NoError(t, err)

	require.Equal(t, []string{"healthy"}, storedIDs(reopened))
	require.Len(t, quarantinedFiles(t, dir, "dashboard", "broken"), 1, "a restart must not quarantine a second copy")
	require.Equal(t, int64(1), quarantinedTotal(t, reader, "dashboard"), "a restart must not increment the counter")
	require.NotContains(t, logs.String(), "quarantined", "a restart must not log a second quarantine")
}

// The quarantine tree is never read as store entries, even when it holds documents that would load.
func TestQuarantineDirectoryIsIgnoredByLoaders(t *testing.T) {
	dir := t.TempDir()
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", nil))
	valid := storedDashboardDocument(t, "old", nil)
	invalid := storedDashboardDocument(t, "bad", map[string]any{"timeRange": "bogus"})
	oldCopy := filepath.Join(dir, "quarantine", "dashboard", "old.1.json")
	badCopy := filepath.Join(dir, "quarantine", "dashboard", "bad.2.json")
	savedCopy := filepath.Join(dir, "quarantine", "saved_query", "query.3.json")
	writeStoredFile(t, oldCopy, valid)
	writeStoredFile(t, badCopy, invalid)
	writeStoredFile(t, savedCopy, []byte(`{"not":"a saved query"}`))
	reader := quarantineMetrics(t)

	store, err := OpenStore(dir)
	require.NoError(t, err)
	require.Equal(t, []string{"healthy"}, storedIDs(store))
	_, _, err = store.Get("old")
	require.ErrorIs(t, err, ErrNotFound)

	saved, err := openSavedQueryStore(dir)
	require.NoError(t, err)
	require.Empty(t, saved.list(""), "quarantined saved queries are not loaded")

	for _, path := range []string{oldCopy, badCopy, savedCopy} {
		require.FileExists(t, path, "the quarantine tree is left alone")
	}
	require.Equal(t, int64(0), quarantinedTotal(t, reader, "dashboard"))
	require.Equal(t, int64(0), quarantinedTotal(t, reader, "saved_query"))
}

// A create with a quarantined id is a new document. The quarantined copy stays for manual recovery.
func TestCreateAfterQuarantineIsNewDocumentAndCopyStays(t *testing.T) {
	dir := t.TempDir()
	broken := storedDashboardDocument(t, "broken", map[string]any{"timeRange": "bogus"})
	writeStoredFile(t, filepath.Join(dir, "broken.json"), broken)
	_ = quarantineMetrics(t)

	store, err := OpenStore(dir)
	require.NoError(t, err)
	fresh := storedDashboardDocument(t, "broken", map[string]any{"title": "Fresh"})
	_, err = store.Put("broken", fresh, "", "*")
	require.NoError(t, err, "the id is free again after quarantine")

	copies := quarantinedFiles(t, dir, "dashboard", "broken")
	require.Len(t, copies, 1)
	kept, err := os.ReadFile(filepath.Join(dir, "quarantine", "dashboard", copies[0])) //nolint:gosec // The test reads a copy it just created under t.TempDir.
	require.NoError(t, err)
	require.JSONEq(t, string(broken), string(kept), "the quarantined copy is never overwritten")

	reopened, err := OpenStore(dir)
	require.NoError(t, err)
	current, _, err := reopened.Get("broken")
	require.NoError(t, err)
	require.JSONEq(t, string(fresh), string(current))
}

// A document written by a newer build, with a newer schema version or a field this build does not know, is
// quarantined rather than refused.
func TestNewerSchemaDocumentIsQuarantinedNotFatal(t *testing.T) {
	dir := t.TempDir()
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", nil))
	future := storedDashboardDocument(t, "future", map[string]any{"schemaVersion": 2, "futureSetting": map[string]any{"mode": "x"}})
	writeStoredFile(t, filepath.Join(dir, "future.json"), future)
	reader := quarantineMetrics(t)
	logs := captureLogs(t)

	store, err := OpenStore(dir)
	require.NoError(t, err, "a newer document must not stop a downgraded build from opening")
	require.Equal(t, []string{"healthy"}, storedIDs(store))
	require.Len(t, quarantinedFiles(t, dir, "dashboard", "future"), 1)
	require.Equal(t, int64(1), quarantinedTotal(t, reader, "dashboard"))
	require.Contains(t, logs.String(), "id=future")
}

// A stored zone the canonical list lacks is still a valid document. Only an invalid document is quarantined, and a
// stale zone never hides an invalid field.
func TestStaleZoneWithInvalidFieldIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	document := storedDashboardDocument(t, "broken", map[string]any{"timeZone": "Factory", "timeRange": "bogus"})
	writeStoredFile(t, filepath.Join(dir, "broken.json"), document)
	_ = quarantineMetrics(t)

	store, err := OpenStore(dir)
	require.NoError(t, err)
	require.Empty(t, storedIDs(store))
	require.Len(t, quarantinedFiles(t, dir, "dashboard", "broken"), 1)
}

// A document over the size limit is an invalid stored document too, so it is quarantined rather than refused.
func TestOversizedDashboardIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", nil))
	oversized := append([]byte(`{"schemaVersion":1}`), bytes.Repeat([]byte(" "), maxDocumentBytes)...)
	writeStoredFile(t, filepath.Join(dir, "huge.json"), oversized)
	_ = quarantineMetrics(t)

	store, err := OpenStore(dir)
	require.NoError(t, err)
	require.Equal(t, []string{"healthy"}, storedIDs(store))
	require.Len(t, quarantinedFiles(t, dir, "dashboard", "huge"), 1)
}

// Saved queries follow the same rule: an invalid document moves to quarantine/saved_query, the rest load, and a
// restart is idempotent.
func TestSavedQueryStoreQuarantinesInvalidDocuments(t *testing.T) {
	dir := t.TempDir()
	s, err := openSavedQueryStore(dir)
	require.NoError(t, err)
	writeStoredFile(t, filepath.Join(s.dir, "healthy.json"), savedQueryJSON(t, savedQueryDocument("healthy")))
	future := savedQueryDocument("broken")
	future["schemaVersion"] = 2
	writeStoredFile(t, filepath.Join(s.dir, "broken.json"), savedQueryJSON(t, future))
	reader := quarantineMetrics(t)
	logs := captureLogs(t)

	reopened, err := openSavedQueryStore(dir)
	require.NoError(t, err, "one invalid saved query must not stop the store from opening")
	require.Len(t, reopened.list(""), 1)
	require.NoFileExists(t, filepath.Join(s.dir, "broken.json"))
	require.Len(t, quarantinedFiles(t, dir, "saved_query", "broken"), 1)
	require.Equal(t, int64(1), quarantinedTotal(t, reader, "saved_query"))
	require.Contains(t, logs.String(), "kind=saved_query")

	again, err := openSavedQueryStore(dir)
	require.NoError(t, err)
	require.Len(t, again.list(""), 1)
	require.Len(t, quarantinedFiles(t, dir, "saved_query", "broken"), 1, "a restart must not quarantine again")
	require.Equal(t, int64(1), quarantinedTotal(t, reader, "saved_query"))
}

// Dashboards and saved queries share the data root. A quarantined saved query does not disturb dashboard loading.
func TestQuarantineKeepsDashboardsAndSavedQueriesApart(t *testing.T) {
	dir := t.TempDir()
	writeStoredFile(t, filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", nil))
	s, err := openSavedQueryStore(dir)
	require.NoError(t, err)
	writeStoredFile(t, filepath.Join(s.dir, "broken.json"), []byte(`{"id":"broken"}`))
	_ = quarantineMetrics(t)

	store, err := OpenStore(dir)
	require.NoError(t, err)
	require.Equal(t, []string{"healthy"}, storedIDs(store))
	require.Empty(t, quarantinedFiles(t, dir, "dashboard", "broken"))
	_, err = openSavedQueryStore(dir)
	require.NoError(t, err)
	require.Len(t, quarantinedFiles(t, dir, "saved_query", "broken"), 1)
}
