package observabilitygateway_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

// revisionSummary is the part of a protojson DashboardRevision these tests read.
type revisionSummary struct {
	Number  uint32 `json:"number"`
	ETag    string `json:"etag"`
	Source  string `json:"source"`
	Message string `json:"message"`
	Author  struct {
		Subject string `json:"subject"`
		Name    string `json:"name"`
	} `json:"author"`
}

func revisionsOf(t *testing.T, h *authoringHarness, p *auth.Principal, id string) []revisionSummary {
	t.Helper()
	list, err := h.call(t, p, "list_dashboard_revisions", map[string]any{"id": id})
	require.NoError(t, err)
	var revisions []revisionSummary
	require.NoError(t, json.Unmarshal(list["revisions"], &revisions))
	return revisions
}

func stringField(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var value string
	require.NoError(t, json.Unmarshal(raw, &value))
	return value
}

func TestInsightsRevisionToolsAreScopedAndRegistered(t *testing.T) {
	h := newAuthoringHarness(t)
	for name, scope := range map[string]mcp.Scope{
		"list_dashboard_revisions":   mcp.ScopeObserve,
		"get_dashboard_revision":     mcp.ScopeObserve,
		"restore_dashboard_revision": mcp.ScopeInsightsWrite,
	} {
		tool, found := h.registry.Lookup(name)
		require.True(t, found, name)
		require.Equal(t, scope, tool.Scope, name)
		require.False(t, tool.Destructive, name)
		require.True(t, json.Valid(tool.InputSchema), name)
	}
	require.Len(t, h.registry.All(), 17)
	restore, found := h.registry.Lookup("restore_dashboard_revision")
	require.True(t, found)
	require.Contains(t, string(restore.InputSchema), "At most 200 UTF-16 units", "the schema states the units the server counts")
}

// A dashboard save records its MCP author, source and message, and the history lists them newest first.
func TestInsightsRevisionHistoryRecordsMCPWritesAndRestores(t *testing.T) {
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	created, err := h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Initial")})
	require.NoError(t, err)
	firstETag := stringField(t, created["etag"])
	updated, err := h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Retitled"), "etag": firstETag, "message": "Retitle the board"})
	require.NoError(t, err)
	currentETag := stringField(t, updated["etag"])

	revisions := revisionsOf(t, h, p, "mcp-demo")
	require.Len(t, revisions, 2)
	require.EqualValues(t, 2, revisions[0].Number)
	require.Equal(t, "Retitle the board", revisions[0].Message, "the message reaches the revision")
	require.Equal(t, "REVISION_SOURCE_MCP", revisions[0].Source, "a write made through MCP records the MCP source")
	require.Equal(t, "human", revisions[0].Author.Subject)
	require.Empty(t, revisions[0].Author.Name, "the test principal has no display name")
	require.EqualValues(t, 1, revisions[1].Number)
	require.Empty(t, revisions[1].Message)
	require.Equal(t, "REVISION_SOURCE_MCP", revisions[1].Source)

	limited, err := h.call(t, p, "list_dashboard_revisions", map[string]any{"id": "mcp-demo", "limit": 1})
	require.NoError(t, err)
	require.JSONEq(t, `[{"number":2}]`, compactRevisionNumbers(t, limited["revisions"]))
	_, err = h.call(t, p, "list_dashboard_revisions", map[string]any{"id": "mcp-demo", "limit": 21})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	first, err := h.call(t, p, "get_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1})
	require.NoError(t, err)
	require.Equal(t, firstETag, stringField(t, first["etag"]), "a revision's ETag is the content ETag of its bytes")
	require.Contains(t, string(first["document"]), `"title":"Initial"`)

	_, err = h.call(t, p, "get_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 99})
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = h.call(t, p, "get_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 0})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	// A restore needs the current ETag: a stale one is refused and writes nothing.
	_, err = h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": firstETag, "message": ""})
	require.Equal(t, connect.CodeAborted, connect.CodeOf(err), "a stale ETag is a conflict")
	_, err = h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": ""})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": currentETag, "unexpected": true})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	require.Len(t, revisionsOf(t, h, p, "mcp-demo"), 2, "refused restores add no revision")

	restored, err := h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": currentETag})
	require.NoError(t, err)
	require.EqualValues(t, 3, decodeNumber(t, restored["revision"]))
	require.EqualValues(t, 1, decodeNumber(t, restored["restoredFrom"]))
	require.Equal(t, firstETag, stringField(t, restored["etag"]), "restoring a revision brings back its content ETag")
	require.Contains(t, string(restored["document"]), `"title":"Initial"`)
	require.Empty(t, restored["driftedSavedQueries"])

	revisions = revisionsOf(t, h, p, "mcp-demo")
	require.Len(t, revisions, 3)
	require.Equal(t, "REVISION_SOURCE_RESTORE", revisions[0].Source)
	require.Equal(t, "Restored revision 1", revisions[0].Message, "the default restore message names the revision")

	// Restoring bytes that equal the current document adds no revision.
	noop, err := h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": firstETag, "message": "Nothing to do"})
	require.NoError(t, err)
	require.EqualValues(t, 3, decodeNumber(t, noop["revision"]))
	require.Len(t, revisionsOf(t, h, p, "mcp-demo"), 3)

	events := h.auditor.events
	require.NotEmpty(t, events)
	var restores []string
	for _, event := range events {
		if event.Action == "restore" {
			restores = append(restores, event.Error)
		}
	}
	require.Equal(t, []string{connect.CodeAborted.String(), connect.CodeInvalidArgument.String(), "", ""}, restores, "each restore that reaches the write is audited as a restore, with its outcome")
}

// Restore reports the saved queries that changed since the revision, and leaves them as they are.
func TestInsightsRestoreReportsSavedQueryDriftThroughMCP(t *testing.T) {
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	query := map[string]any{"schemaVersion": 1, "id": "mcp-query", "name": "Requests", "providerId": "prometheus", "kind": "metrics", "query": "up", "parameters": []any{}}
	createdQuery, err := h.call(t, p, "create_saved_query", map[string]any{"document": query})
	require.NoError(t, err)
	queryETag := stringField(t, createdQuery["etag"])

	dashboard := map[string]any{"schemaVersion": 1, "id": "mcp-demo", "title": "Pinned", "timeRange": "1h", "refreshInterval": 30, "widgets": []any{map[string]any{
		"id": "requests", "title": "Requests", "type": "timeseries", "providerId": "prometheus", "query": "up", "unit": "req/s",
		"layout": map[string]any{"x": 0, "y": 0, "w": 6, "h": 4}, "queryRef": map[string]any{"id": "mcp-query", "bindings": []any{}},
	}}}
	created, err := h.call(t, p, "create_dashboard", map[string]any{"document": dashboard})
	require.NoError(t, err)
	pinnedETag := stringField(t, created["etag"])
	plain, err := h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Plain"), "etag": pinnedETag})
	require.NoError(t, err)
	plainETag := stringField(t, plain["etag"])

	query["query"] = "up == 1"
	updatedQuery, err := h.call(t, p, "update_saved_query", map[string]any{"document": query, "etag": queryETag})
	require.NoError(t, err)
	updatedQueryETag := stringField(t, updatedQuery["etag"])

	restored, err := h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": plainETag})
	require.NoError(t, err)
	var drifted []struct {
		ID   string `json:"id"`
		ETag string `json:"etag"`
	}
	require.NoError(t, json.Unmarshal(restored["driftedSavedQueries"], &drifted))
	require.Equal(t, []struct {
		ID   string `json:"id"`
		ETag string `json:"etag"`
	}{{ID: "mcp-query", ETag: queryETag}}, drifted, "the pin the revision recorded is reported")
	require.Empty(t, restored["driftUnknown"])

	// Restoring the content already current adds no revision, so it reports no drift of its own, even though the
	// current head revision recorded some.
	noop, err := h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": stringField(t, restored["etag"])})
	require.NoError(t, err)
	require.EqualValues(t, 3, decodeNumber(t, noop["revision"]))
	require.Empty(t, noop["driftedSavedQueries"])

	saved, err := h.call(t, p, "get_saved_query", map[string]any{"id": "mcp-query"})
	require.NoError(t, err)
	require.Equal(t, updatedQueryETag, stringField(t, saved["etag"]), "restore leaves saved queries as they are")
}

// A restore whose history write fails names no revision, so its drift is reported as unknown rather than as none.
func TestInsightsRestoreReportsUnknownDriftWhenHistoryWriteFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("file permissions do not stop root")
	}
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	created, err := h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Initial")})
	require.NoError(t, err)
	firstETag := stringField(t, created["etag"])
	updated, err := h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Retitled"), "etag": firstETag})
	require.NoError(t, err)
	currentETag := stringField(t, updated["etag"])

	// The history directory is read-only: revision 1 can still be read, but the restore cannot record its revision.
	history := filepath.Join(h.dataDir, "revisions", "mcp-demo")
	require.NoError(t, os.Chmod(history, 0o500))       //nolint:gosec // a read-only history directory is the failure under test
	t.Cleanup(func() { _ = os.Chmod(history, 0o700) }) //nolint:gosec // restores the directory so the temp dir can be removed

	restored, err := h.call(t, p, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": currentETag})
	require.NoError(t, err)
	require.Contains(t, string(restored["document"]), `"title":"Initial"`, "the restore itself is kept")
	require.EqualValues(t, 0, decodeNumber(t, restored["revision"]), "no revision names the restore")
	require.JSONEq(t, "true", string(restored["driftUnknown"]), "the drift is unknown, not an all-clear")
	require.Empty(t, restored["driftedSavedQueries"])
}

// Saved queries have no revisions, so their writes refuse a message, and an overlong or control-character message fails.
func TestInsightsRevisionMessagesAreDashboardOnlyAndChecked(t *testing.T) {
	h := newAuthoringHarness(t)
	p := authoringPrincipal([]string{"editors"}, true)
	query := map[string]any{"schemaVersion": 1, "id": "mcp-query", "name": "Requests", "providerId": "prometheus", "kind": "metrics", "query": "up", "parameters": []any{}}
	_, err := h.call(t, p, "create_saved_query", map[string]any{"document": query, "message": "Not for queries"})
	require.Error(t, err)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	createdQuery, err := h.call(t, p, "create_saved_query", map[string]any{"document": query})
	require.NoError(t, err)
	queryETag := stringField(t, createdQuery["etag"])

	created, err := h.call(t, p, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Initial")})
	require.NoError(t, err)
	etag := stringField(t, created["etag"])
	_, err = h.call(t, p, "patch_dashboard", map[string]any{"id": "mcp-demo", "etag": etag, "patch": map[string]any{"title": "Patched"}, "message": "Patch note"})
	require.NoError(t, err)
	require.Equal(t, "Patch note", revisionsOf(t, h, p, "mcp-demo")[0].Message, "a patch carries its message too")

	current := revisionsOf(t, h, p, "mcp-demo")[0].ETag
	_, err = h.call(t, p, "patch_saved_query", map[string]any{"id": "mcp-query", "etag": queryETag, "patch": map[string]any{"name": "Renamed"}, "message": "Not for queries"})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	long := strings.Repeat("a", 201)
	_, err = h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Long"), "etag": current, "message": long})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "a message over 200 units is refused")
	_, err = h.call(t, p, "update_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Control"), "etag": current, "message": "bad\u0001note"})
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "control characters are refused")
	require.Len(t, revisionsOf(t, h, p, "mcp-demo"), 2, "refused saves add no revision")
}

// Restoring needs paprika:insights:write and the human's Insights write permission. Reads need only observe scope.
func TestInsightsRevisionRestoreNeedsWriteAccess(t *testing.T) {
	h := newAuthoringHarness(t)
	writer := authoringPrincipal([]string{"editors"}, true)
	created, err := h.call(t, writer, "create_dashboard", map[string]any{"document": authoringDocument(t, "dashboard", "Initial")})
	require.NoError(t, err)
	etag := stringField(t, created["etag"])

	observer := authoringPrincipal([]string{"editors"}, false)
	_, err = h.call(t, observer, "list_dashboard_revisions", map[string]any{"id": "mcp-demo"})
	require.NoError(t, err)
	_, err = h.call(t, observer, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": etag})
	require.ErrorIs(t, err, mcp.ErrScopeDenied, "observe scope alone cannot restore")

	readOnlyRBAC := authoringPrincipal([]string{"readers"}, true)
	_, err = h.call(t, readOnlyRBAC, "restore_dashboard_revision", map[string]any{"id": "mcp-demo", "revision": 1, "etag": etag})
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err), "a reader without Insights write permission is refused by the proxy")
	require.Len(t, revisionsOf(t, h, writer, "mcp-demo"), 1)
}

func compactRevisionNumbers(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var revisions []struct {
		Number uint32 `json:"number"`
	}
	require.NoError(t, json.Unmarshal(raw, &revisions))
	data, err := json.Marshal(revisions)
	require.NoError(t, err)
	return string(data)
}

func decodeNumber(t *testing.T, raw json.RawMessage) int64 {
	t.Helper()
	var value int64
	require.NoError(t, json.Unmarshal(raw, &value))
	return value
}
