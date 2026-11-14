package insights

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// storedDashboardDocument is a valid dashboard as the store holds it, with fields overridden or added by extra.
func storedDashboardDocument(t *testing.T, id string, extra map[string]any) []byte {
	t.Helper()
	doc := map[string]any{"schemaVersion": 1, "id": id, "title": "Stored " + id, "timeRange": "1h", "refreshInterval": 0, "widgets": []any{}}
	for key, value := range extra {
		doc[key] = value
	}
	data, err := json.Marshal(doc)
	require.NoError(t, err)
	return data
}

// A stored zone the canonical list lacks must not stop the store from opening. The document loads as stored, the
// warning names it, and writes stay strict.
func TestOpenStoreLoadsDashboardWithStaleTimeZone(t *testing.T) {
	dir := t.TempDir()
	stale := storedDashboardDocument(t, "stale-zone", map[string]any{"timeZone": "Factory"})
	require.NoError(t, os.WriteFile(filepath.Join(dir, "stale-zone.json"), stale, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "healthy.json"), storedDashboardDocument(t, "healthy", map[string]any{"timeZone": "Europe/London"}), 0o600))

	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	store, err := OpenStore(dir)
	require.NoError(t, err, "one stale zone must not stop the store from opening")
	require.Contains(t, logs.String(), "level=WARN")
	require.Contains(t, logs.String(), "dashboard=stale-zone", "the warning must name the dashboard")
	require.NotContains(t, logs.String(), "dashboard=healthy", "a canonical zone is not reported")

	doc, _, err := store.Get("stale-zone")
	require.NoError(t, err)
	require.JSONEq(t, string(stale), string(doc), "the stale zone is kept as stored")
	require.Len(t, store.List(), 2, "the stale dashboard does not hide the others")

	_, err = store.Put("stale-zone", stale, "", "")
	require.Error(t, err, "writes still refuse a zone the canonical list lacks")
}

// Whatever a stored zone holds, the store opens and keeps the document. Only the zone is exempt.
func TestOpenStoreKeepsAnyStoredTimeZoneValue(t *testing.T) {
	for _, zone := range []any{"Factory", "Local", "+05:30", "europe/london", "Not/AZone", "", nil, 5, map[string]any{"name": "UTC"}} {
		dir := t.TempDir()
		document := storedDashboardDocument(t, "zoned", map[string]any{"timeZone": zone})
		require.NoError(t, os.WriteFile(filepath.Join(dir, "zoned.json"), document, 0o600))
		store, err := OpenStore(dir)
		require.NoError(t, err, "zone %v", zone)
		doc, _, err := store.Get("zoned")
		require.NoError(t, err)
		require.JSONEq(t, string(document), string(doc), "zone %v", zone)
	}
}

// Exempting the zone does not exempt the rest of the document: a stale zone never hides an invalid field. The invalid
// document is quarantined and the store still opens.
func TestOpenStoreStillValidatesOtherFieldsWhenZoneIsStale(t *testing.T) {
	dir := t.TempDir()
	document := storedDashboardDocument(t, "broken", map[string]any{"timeZone": "Factory", "timeRange": "bogus"})
	require.NoError(t, os.WriteFile(filepath.Join(dir, "broken.json"), document, 0o600))
	_ = quarantineMetrics(t)
	store, err := OpenStore(dir)
	require.NoError(t, err, "an invalid document is quarantined, not fatal")
	require.NoError(t, store.commitQuarantine())
	_, _, err = store.Get("broken")
	require.ErrorIs(t, err, ErrNotFound)
	require.Len(t, quarantinedFiles(t, dir, "dashboard", "broken"), 1)
}
