package insights

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// storedOverlapService opens a store that already holds dashboard "demo" as the
// given document, the way a dashboard written before the overlap rule would.
func storedOverlapService(t *testing.T, document Dashboard) (*Server, *Store) {
	t.Helper()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "demo.json"), document, 0o600))
	store, err := OpenStore(dir)
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken}, store)
	require.NoError(t, err)
	return s, store
}

// checksOf reads the checks field of a successful save or dry run.
func checksOf(t *testing.T, body []byte) reportBody {
	t.Helper()
	var wrapper struct {
		Checks reportBody `json:"checks"`
	}
	require.NoError(t, json.Unmarshal(body, &wrapper))
	return wrapper.Checks
}

// An overlap that the stored dashboard already has is grandfathered: a harmless
// edit that leaves that pair overlapping is saved, and the overlap is a warning.
func TestUpdateKeepsAnExistingStoredOverlapAsWarning(t *testing.T) {
	stored := overlappingDocument("demo")
	s, store := storedOverlapService(t, stored)
	h := s.Handler()
	_, etag, err := store.Get("demo")
	require.NoError(t, err)

	edited := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
	)
	edited = json.RawMessage(replaceOnce(t, string(edited), `"title":"Checks"`, `"title":"Renamed"`))

	dry := request(t, h, "POST", "/api/dashboards/validate", checkBody(edited), nil)
	require.Equal(t, http.StatusOK, dry.Code, "dry run body %s", dry.Body)
	var dryReport reportBody
	require.NoError(t, json.Unmarshal(dry.Body.Bytes(), &dryReport))
	require.Zero(t, dryReport.ErrorCount, "dry run blocks a grandfathered overlap")

	w := request(t, h, "PUT", "/api/dashboards/demo?checks=true", edited, map[string]string{"If-Match": etag})
	require.Equal(t, http.StatusOK, w.Code, "grandfathered overlap blocked the save: %s", w.Body)
	checks := checksOf(t, w.Body.Bytes())
	require.Zero(t, checks.ErrorCount)
	require.Equal(t, uint32(1), checks.WarningCount)
	require.Len(t, checks.Issues, 1)
	require.Equal(t, "layout.overlap", checks.Issues[0].RuleID)

	saved, _, err := store.Get("demo")
	require.NoError(t, err)
	require.Contains(t, string(saved), `"Renamed"`)
}

// An overlap between a pair that did not overlap in the stored version is still an
// error and blocks the save, even when another pair was already overlapping.
func TestUpdateRejectsANewOverlapBesideAStoredOne(t *testing.T) {
	stored := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("c", `{"x":0,"y":8,"w":6,"h":4}`, ""),
	)
	s, store := storedOverlapService(t, stored)
	h := s.Handler()
	_, etag, err := store.Get("demo")
	require.NoError(t, err)

	// c moves up onto a, and onto b: both pairs are new.
	edited := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("c", `{"x":0,"y":2,"w":6,"h":4}`, ""),
	)
	w := request(t, h, "PUT", "/api/dashboards/demo", edited, map[string]string{"If-Match": etag})
	require.Equal(t, http.StatusBadRequest, w.Code, "new overlap saved: %s", w.Body)
	var body savedBody
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	var newErrors, storedWarnings int
	for _, issue := range body.Issues {
		if issue["ruleId"] == "layout.overlap" && issue["severity"] == "SEVERITY_ERROR" && issue["widgetId"] == "c" {
			newErrors++
		}
		if issue["ruleId"] == "layout.overlap" && issue["severity"] == "SEVERITY_WARNING" && issue["widgetId"] == "b" {
			storedWarnings++
		}
	}
	require.Equal(t, 2, newErrors, "each new pair is an error naming c: %v", body.Issues)
	require.Equal(t, 1, storedWarnings, "the stored a-b pair is a warning on b in the same body: %v", body.Issues)

	current, _, err := store.Get("demo")
	require.NoError(t, err)
	require.Equal(t, string(stored), string(current), "rejected update changed the stored document")
}

// A create has no stored version, so every overlap is an error, as before.
func TestCreateKeepsOverlapAsError(t *testing.T) {
	s, store := testService(t)
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", overlappingDocument("demo"), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusBadRequest, w.Code, "create body %s", w.Body)
	var body savedBody
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Len(t, body.Issues, 1)
	require.Equal(t, "SEVERITY_ERROR", body.Issues[0]["severity"])
	_, _, err := store.Get("demo")
	require.Error(t, err)
}

// The overlap pairs of a stored document are read the same way a save reads them, so
// the grandfathered set matches the pairs a save reports.
func TestStoredOverlapPairsMatchTheSavedPairs(t *testing.T) {
	known := storedOverlaps(overlappingDocument("demo"))
	require.Equal(t, map[overlapKey]bool{overlapKeyOf("a", "b"): true}, known)
	require.Nil(t, storedOverlaps(nil), "a create has no stored overlaps")
}

func replaceOnce(t *testing.T, s, old, replacement string) string {
	t.Helper()
	require.Equal(t, 1, strings.Count(s, old), "the test document must contain %q once", old)
	return strings.Replace(s, old, replacement, 1)
}
