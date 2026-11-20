package insights

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// revisionListBody is the revision list as protojson writes it.
type revisionListBody struct {
	DashboardID    string `json:"dashboardId"`
	RetentionLimit uint32 `json:"retentionLimit"`
	CurrentETag    string `json:"currentEtag"`
	Revisions      []struct {
		Number       uint32 `json:"number"`
		ETag         string `json:"etag"`
		Source       string `json:"source"`
		Message      string `json:"message"`
		RestoredFrom uint32 `json:"restoredFrom"`
		Author       struct {
			Subject string `json:"subject"`
			Name    string `json:"name"`
		} `json:"author"`
		SavedQueries        []revisionPinBody `json:"savedQueries"`
		DriftedSavedQueries []revisionPinBody `json:"driftedSavedQueries"`
	} `json:"revisions"`
}

type revisionPinBody struct {
	ID   string `json:"id"`
	ETag string `json:"etag"`
}

func listRevisions(t *testing.T, h http.Handler, id string) revisionListBody {
	t.Helper()
	w := request(t, h, "GET", "/api/dashboards/"+id+"/revisions", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var list revisionListBody
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &list))
	return list
}

// Revisions list newest first with the current ETag, and a revision reads back as the exact bytes it saved.
func TestRevisionListAndGetAreNewestFirstAndExact(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	first := dashboard("demo", "First")
	w := request(t, h, "PUT", "/api/dashboards/demo", first, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	firstTag := w.Header().Get("ETag")
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Second"), map[string]string{"If-Match": firstTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	secondTag := w.Header().Get("ETag")

	list := listRevisions(t, h, "demo")
	assert.Equal(t, "demo", list.DashboardID)
	assert.Equal(t, uint32(maxRevisionsPerDashboard), list.RetentionLimit)
	assert.Equal(t, secondTag, list.CurrentETag)
	require.Len(t, list.Revisions, 2)
	assert.Equal(t, uint32(2), list.Revisions[0].Number, "newest first")
	assert.Equal(t, uint32(1), list.Revisions[1].Number)
	assert.Equal(t, firstTag, list.Revisions[1].ETag)

	w = request(t, h, "GET", "/api/dashboards/demo/revisions/1", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, string(first), w.Body.String(), "a revision returns the bytes it saved")
	assert.Equal(t, firstTag, w.Header().Get("ETag"))
	assert.Equal(t, firstTag, w.Header().Get(documentETagHeader))
	assert.Equal(t, "1", w.Header().Get(revisionNumberHeader))
}

func TestRevisionReadsRejectBadAndMissingRevisions(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	require.Equal(t, http.StatusOK, request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Only"), map[string]string{"If-None-Match": "*"}).Code)
	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/api/dashboards/demo/revisions/9", http.StatusNotFound},
		{"GET", "/api/dashboards/demo/revisions/0", http.StatusBadRequest},
		{"GET", "/api/dashboards/demo/revisions/latest", http.StatusBadRequest},
		{"GET", "/api/dashboards/missing/revisions", http.StatusNotFound},
		{"GET", "/api/dashboards/missing/revisions/1", http.StatusNotFound},
		{"POST", "/api/dashboards/missing/revisions/1/restore", http.StatusNotFound},
	} {
		w := request(t, h, tc.method, tc.path, nil, map[string]string{"If-Match": "\"x\""})
		assert.Equal(t, tc.want, w.Code, "%s %s: %s", tc.method, tc.path, w.Body.String())
	}
}

// Restore writes a new revision that records its source, and needs the current ETag. A stale ETag writes nothing.
func TestRestoreNeedsCurrentETagAndWritesANewRevision(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code)
	oneTag := w.Header().Get("ETag")
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Two"), map[string]string{"If-Match": oneTag})
	require.Equal(t, http.StatusOK, w.Code)
	twoTag := w.Header().Get("ETag")

	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, nil)
	assert.Equal(t, http.StatusPreconditionRequired, w.Code, "restore without If-Match: %s", w.Body.String())
	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": "*"})
	assert.Equal(t, http.StatusPreconditionRequired, w.Code, "restore with a wildcard: %s", w.Body.String())
	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": "\"stale\""})
	assert.Equal(t, http.StatusPreconditionFailed, w.Code, "stale restore: %s", w.Body.String())
	require.Len(t, listRevisions(t, h, "demo").Revisions, 2, "a refused restore writes nothing")

	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": twoTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, oneTag, w.Header().Get("ETag"), "the restored document has revision 1's ETag")
	assert.Equal(t, "3", w.Header().Get(revisionNumberHeader))
	assert.Equal(t, "1", w.Header().Get(restoredFromHeader))

	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 3)
	assert.Equal(t, uint32(3), list.Revisions[0].Number)
	assert.Equal(t, "REVISION_SOURCE_RESTORE", list.Revisions[0].Source)
	assert.Equal(t, uint32(1), list.Revisions[0].RestoredFrom)
	assert.Equal(t, "Restored revision 1", list.Revisions[0].Message)
	assert.Equal(t, oneTag, list.CurrentETag)

	// The restored ETag equals revision 1's ETag, so a client that holds it may write again. This is deliberate: the
	// precondition proves the writer saw these exact bytes.
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Three"), map[string]string{"If-Match": oneTag})
	assert.Equal(t, http.StatusOK, w.Code, "an ETag that returns after a restore is valid again: %s", w.Body.String())
}

// Restoring the document that is already current adds no revision and keeps the ETag.
func TestRestoreOfCurrentDocumentIsNoOp(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Only"), map[string]string{"If-None-Match": "*"})
	tag := w.Header().Get("ETag")
	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": tag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, tag, w.Header().Get("ETag"))
	assert.Equal(t, "1", w.Header().Get(revisionNumberHeader), "the head is unchanged")
	assert.Empty(t, w.Header().Get(restoredFromHeader), "no restore happened, so none is named")
	assert.Len(t, listRevisions(t, h, "demo").Revisions, 1)
}

// A revision that the current rules refuse gives 400 with the findings and writes nothing.
func TestRestoreRefusesRevisionThatFailsCurrentRules(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	overlapping := []byte(`{"schemaVersion":1,"id":"demo","title":"Overlap","timeRange":"1h","refreshInterval":30,"widgets":[` +
		`{"id":"a","title":"A","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}},` +
		`{"id":"b","title":"B","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4}}]}`)
	// The store checks the schema only, so this overlapping document becomes revision 1 directly. The save path refuses
	// it when it is restored, because the overlap is new to the current dashboard.
	_, _, err := store.PutRevision("demo", overlapping, "", "", RevisionMeta{})
	require.NoError(t, err)
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Clean"), nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	tag := w.Header().Get("ETag")

	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": tag})
	assert.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	assert.Contains(t, w.Body.String(), `"issues"`, "the refusal carries the findings")
	assert.Len(t, listRevisions(t, h, "demo").Revisions, 2, "the refused restore writes nothing")
}

// The message header is stored. A message that is too long, has a control character or is not valid encoding is
// refused before anything is written.
func TestRevisionMessageHeaderIsStoredAndChecked(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{"If-None-Match": "*", "X-Insights-Revision-Message": "Rename%20the%20dashboard"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	tag := w.Header().Get("ETag")
	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 1)
	assert.Equal(t, "Rename the dashboard", list.Revisions[0].Message)

	cases := map[string]string{
		"too long":        strings.Repeat("a", 201),
		"control char":    "line%0Abreak",
		"bad percent":     "%E0%A4%A",
		"invalid utf-8":   "%FF",
		"too many emojis": strings.Repeat("%F0%9F%98%80", 101),
	}
	for name, message := range cases {
		w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Two "+name), map[string]string{"If-Match": tag, "X-Insights-Revision-Message": message})
		assert.Equal(t, http.StatusBadRequest, w.Code, "%s: %s", name, w.Body.String())
	}
	assert.Len(t, listRevisions(t, h, "demo").Revisions, 1, "refused messages write nothing")

	// 200 UTF-16 units is the limit: 100 emoji are 200 units and are accepted.
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Limit"), map[string]string{"If-Match": tag, "X-Insights-Revision-Message": strings.Repeat("%F0%9F%98%80", 100)})
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// Author and source come from the headers the proxy sets. A source other than ui or mcp is refused, and a save of the
// same bytes adds no revision.
func TestSaveHeadersBecomeAuthorAndSource(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{
		"If-None-Match":                     "*",
		"X-Paprika-Revision-Author-Subject": "user-123",
		"X-Paprika-Revision-Author-Name":    "Ben%20Ebsworth",
		"X-Paprika-Revision-Source":         "mcp",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	tag := w.Header().Get("ETag")
	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 1)
	assert.Equal(t, "user-123", list.Revisions[0].Author.Subject)
	assert.Equal(t, "Ben Ebsworth", list.Revisions[0].Author.Name)
	assert.Equal(t, "REVISION_SOURCE_MCP", list.Revisions[0].Source)

	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Two"), map[string]string{"If-Match": tag, "X-Paprika-Revision-Source": "email"})
	assert.Equal(t, http.StatusBadRequest, w.Code, "an unknown source is refused: %s", w.Body.String())

	// Saving the same bytes again adds no revision, and the response names the head.
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{"If-Match": tag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, "1", w.Header().Get(revisionNumberHeader))
	assert.Len(t, listRevisions(t, h, "demo").Revisions, 1)
}

// Insecure development mode has no service token, so it ignores the identity and source headers.
func TestInsecureDevelopmentIgnoresIdentityHeaders(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	s, err := NewServer(Config{InsecureDev: true}, store)
	require.NoError(t, err)
	h := s.Handler()
	w := requestWithoutAuth(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{
		"If-None-Match":                     "*",
		"X-Paprika-Revision-Author-Subject": "someone-else",
		"X-Paprika-Revision-Source":         "mcp",
	})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 1)
	assert.Empty(t, list.Revisions[0].Author.Subject)
	assert.Equal(t, "REVISION_SOURCE_UI", list.Revisions[0].Source)
}

// requestWithoutAuth sends a request without the service token, for the insecure development server.
func requestWithoutAuth(t *testing.T, h http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequestWithContext(t.Context(), method, path, bytes.NewReader(body))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// A restore with checks=true answers with the checks report, as a save does.
func TestRestoreWithChecksReturnsTheReport(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	w := request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "One"), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, http.StatusOK, request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Two"), map[string]string{"If-Match": w.Header().Get("ETag")}).Code)
	current := listRevisions(t, h, "demo").CurrentETag
	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore?checks=true", nil, map[string]string{"If-Match": current})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var body map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Contains(t, body, "checks")
	assert.Contains(t, body, "widgets")
}

// Saved queries a revision reads are pinned with their ETags. A restore after one changed reports the drift and leaves
// the saved query as it is.
func TestRevisionPinsReportSavedQueryDrift(t *testing.T) {
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	s, _ := testService(t, provider)
	h := s.Handler()
	query := map[string]any{"schemaVersion": 1, "id": "requests", "name": "Requests", "providerId": "metrics", "kind": "metrics", "query": "up", "parameters": []any{}}
	w := request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, query), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	queryTag := w.Header().Get("ETag")

	w = request(t, h, "PUT", "/api/dashboards/demo", dashboardWithSavedQuery("demo", "Pinned", "requests"), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	pinnedTag := w.Header().Get("ETag")
	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 1)
	require.Equal(t, []revisionPinBody{{ID: "requests", ETag: queryTag}}, list.Revisions[0].SavedQueries)

	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Plain"), map[string]string{"If-Match": pinnedTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	plainTag := w.Header().Get("ETag")

	query["query"] = "up == 1"
	w = request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, query), map[string]string{"If-Match": queryTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	updatedTag := w.Header().Get("ETag")

	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": plainTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	list = listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 3)
	restored := list.Revisions[0]
	assert.Equal(t, "REVISION_SOURCE_RESTORE", restored.Source)
	assert.Equal(t, []revisionPinBody{{ID: "requests", ETag: queryTag}}, restored.DriftedSavedQueries, "the pinned ETag is reported as drifted")
	assert.Equal(t, []revisionPinBody{{ID: "requests", ETag: updatedTag}}, restored.SavedQueries, "the restored document reads the saved query at its current ETag")
	assert.Empty(t, list.Revisions[1].DriftedSavedQueries, "only a restore records drift")
	saved := request(t, h, "GET", "/api/saved-queries/requests", nil, nil)
	assert.Equal(t, updatedTag, saved.Header().Get("ETag"), "restore leaves saved queries as they are")
	assert.Contains(t, saved.Body.String(), "up == 1")
}

// dashboardWithSavedQuery is a one-widget dashboard whose widget reads a saved query.
func dashboardWithSavedQuery(id, title, queryID string) []byte {
	return []byte(fmt.Sprintf(`{"schemaVersion":1,"id":%q,"title":%q,"timeRange":"1h","refreshInterval":30,"widgets":[{"id":"requests","title":"Requests","type":"timeseries","providerId":"metrics","query":"up","unit":"req/s","layout":{"x":0,"y":0,"w":6,"h":4},"queryRef":{"id":%q,"bindings":[]}}]}`, id, title, queryID))
}

// A baseline seeded at startup has no saved-query pins of its own. NewServer records the pins at the same moment, so a
// later change to the saved query is reported as drift when the baseline is restored.
func TestBaselineRevisionRecordsSavedQueryPinsAtStartup(t *testing.T) {
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	dir := t.TempDir()
	first, err := OpenStore(dir)
	require.NoError(t, err)
	before, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{provider}}, first)
	require.NoError(t, err)
	query := map[string]any{"schemaVersion": 1, "id": "requests", "name": "Requests", "providerId": "metrics", "kind": "metrics", "query": "up", "parameters": []any{}}
	w := request(t, before.Handler(), "PUT", "/api/saved-queries/requests", savedQueryJSON(t, query), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	queryTag := w.Header().Get("ETag")
	// A dashboard that predates history: it is on disk and no revision exists yet.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "demo.json"), dashboardWithSavedQuery("demo", "Legacy", "requests"), 0o600))

	store, err := OpenStore(dir)
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{provider}}, store)
	require.NoError(t, err)
	h := s.Handler()
	list := listRevisions(t, h, "demo")
	require.Len(t, list.Revisions, 1)
	require.Equal(t, "REVISION_SOURCE_BASELINE", list.Revisions[0].Source)
	require.Equal(t, []revisionPinBody{{ID: "requests", ETag: queryTag}}, list.Revisions[0].SavedQueries, "the baseline records the saved query it reads")
	baselineTag := list.CurrentETag

	query["query"] = "up == 1"
	w = request(t, h, "PUT", "/api/saved-queries/requests", savedQueryJSON(t, query), map[string]string{"If-Match": queryTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	w = request(t, h, "PUT", "/api/dashboards/demo", dashboard("demo", "Edited"), map[string]string{"If-Match": baselineTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	editedTag := w.Header().Get("ETag")

	w = request(t, h, "POST", "/api/dashboards/demo/revisions/1/restore", nil, map[string]string{"If-Match": editedTag})
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	list = listRevisions(t, h, "demo")
	require.Equal(t, "REVISION_SOURCE_RESTORE", list.Revisions[0].Source)
	assert.Equal(t, []revisionPinBody{{ID: "requests", ETag: queryTag}}, list.Revisions[0].DriftedSavedQueries, "drift from the baseline is reported, not an empty list")
}

// The authoring schema for dashboards tells an agent how revisions and restores behave.
func TestDashboardSchemaNotesDescribeRevisions(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "GET", "/api/schemas/dashboard", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var response authoringSchemaResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	notes := strings.Join(response.Notes, "\n")
	for _, want := range []string{"restore_dashboard_revision", "If-Match", "driftedSavedQueries", "message of at most 200 UTF-16 units"} {
		assert.Contains(t, notes, want)
	}
}
