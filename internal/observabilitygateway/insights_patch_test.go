package observabilitygateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/insights"
)

const patchDashboardFixture = `{"schemaVersion":1,"id":"demo","title":"Service overview","description":"Keep this description","folder":"Services/Production","timeRange":"1h","refreshInterval":0,"variables":[{"name":"service","label":"Service","defaultValue":"api","options":["api","worker"]}],"widgets":[{"id":"rate","title":"Rate","type":"stat","providerId":"metrics","query":"up","unit":"req/s","options":{"decimals":2,"showSparkline":true,"showGrid":true},"layout":{"x":0,"y":0,"w":6,"h":4}},{"id":"plugin","title":"Plugin","type":"plugin","pluginId":"custom","dataKind":"metrics","providerId":"metrics","query":"up","unit":"","config":{"exact":9007199254740993,"precise":1.234567890123456789,"nullValue":null},"layout":{"x":6,"y":0,"w":6,"h":4}}]}`
const patchSavedQueryFixture = `{"schemaVersion":1,"id":"saved","name":"Service rate","description":"Remove this","imageUrl":"/brand/logo.png","tags":["service","old"],"metadata":{"owner":"team","obsolete":"remove"},"providerId":"metrics","kind":"metrics","query":"up{service={{service}}}","parameters":[{"name":"service","type":"string","defaultValue":"api"}]}`
const patchAddedWidget = `{"id":"errors","title":"Errors","type":"stat","providerId":"metrics","query":"up","unit":"%","options":{"decimals":2},"layout":{"x":0,"y":4,"w":6,"h":4}}`

type patchAuditor struct {
	mu     sync.Mutex
	events []audit.Event
}

func (a *patchAuditor) Record(_ context.Context, event audit.Event) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, event)
}

func (a *patchAuditor) snapshot() []audit.Event {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]audit.Event{}, a.events...)
}

type insightsPatchHarness struct {
	c         *InsightsAuthoringClient
	auditor   *patchAuditor
	puts      atomic.Int32
	queries   atomic.Int32
	hookMu    sync.Mutex
	afterGet  func()
	rejectPut bool
}

func patchPrincipal(t *testing.T, groups []string, scopes ...string) context.Context {
	t.Helper()
	return auth.WithPrincipal(t.Context(), &auth.Principal{Subject: "editor", Groups: groups, Scopes: scopes})
}

func patchEditor(t *testing.T) context.Context {
	t.Helper()
	return patchPrincipal(t, []string{"editors"}, "paprika:observe", "paprika:insights:write")
}

func newInsightsPatchHarness(t *testing.T) *insightsPatchHarness {
	t.Helper()
	secret := []byte(rand.Text())
	token := rand.Text() + rand.Text()
	store, err := insights.OpenStore(t.TempDir())
	require.NoError(t, err)
	service, err := insights.NewServer(insights.Config{Token: token, Providers: []insights.ProviderConfig{{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "https://unused.example.test"}}}, store)
	require.NoError(t, err)
	h := &insightsPatchHarness{auditor: &patchAuditor{}}
	handler := service.Handler()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/query") || strings.Contains(r.URL.Path, "/metadata") {
			h.queries.Add(1)
		}
		if r.Method == http.MethodPut {
			h.puts.Add(1)
			h.hookMu.Lock()
			reject := h.rejectPut
			h.hookMu.Unlock()
			if reject {
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
		handler.ServeHTTP(w, r)
		if r.Method == http.MethodGet {
			h.hookMu.Lock()
			hook := h.afterGet
			h.afterGet = nil
			h.hookMu.Unlock()
			if hook != nil {
				hook()
			}
		}
	}))
	t.Cleanup(upstream.Close)
	cfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: []auth.RBACRule{
		{Subjects: []string{"group:editors"}, Actions: []string{"read", "write"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
		{Subjects: []string{"group:readers"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}},
	}}
	proxy, err := apiserver.NewInsightsProxy(t.Context(), cfg, upstream.URL, token)
	require.NoError(t, err)
	h.c, err = NewInsightsAuthoringClient(proxy, secret, "https://paprika.example.test", h.auditor)
	require.NoError(t, err)
	return h
}

func (h *insightsPatchHarness) seed(t *testing.T, collection, document string) *insightsDocumentResult {
	t.Helper()
	result, err := h.c.put(patchEditor(t), collection, insightsAuthoringArgs{Document: json.RawMessage(document)}, true)
	require.NoError(t, err)
	return result
}

func patchArgs(t *testing.T, id, etag, fields string) *insightsPatchArgs {
	t.Helper()
	version, err := json.Marshal(etag)
	require.NoError(t, err)
	args, err := decodeInsightsPatchArgs(json.RawMessage(fmt.Sprintf(`{"id":%q,"etag":%s,%s}`, id, version, fields)))
	require.NoError(t, err)
	return args
}

func TestInsightsPatchPreservesUntouchedFieldsAndExactNumbers(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", patchDashboardFixture)
	args := patchArgs(t, "demo", initial.ETag, `"patch":{"title":"Updated overview","folder":null},"widget_edits":[{"op":"update","id":"rate","patch":{"options":{"decimals":3,"showGrid":null},"layout":{"w":5}}}]`)
	result, err := h.c.patch(patchEditor(t), "dashboards", args)
	require.NoError(t, err)
	require.NotEqual(t, initial.ETag, result.ETag)
	require.Contains(t, result.UIURL, "?dashboard=demo")
	var before, after map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(initial.Document, &before))
	require.NoError(t, json.Unmarshal(result.Document, &after))
	require.NotContains(t, after, "folder")
	require.JSONEq(t, string(before["description"]), string(after["description"]))
	require.JSONEq(t, string(before["variables"]), string(after["variables"]))
	var widgets []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(after["widgets"], &widgets))
	require.JSONEq(t, `{"decimals":3,"showSparkline":true}`, string(widgets[0]["options"]))
	require.JSONEq(t, `{"x":0,"y":0,"w":5,"h":4}`, string(widgets[0]["layout"]))
	require.Contains(t, string(widgets[1]["config"]), "9007199254740993")
	require.Contains(t, string(widgets[1]["config"]), "1.234567890123456789")
	require.Contains(t, string(widgets[1]["config"]), `"nullValue":null`)
	require.Zero(t, h.queries.Load())
	events := h.auditor.snapshot()
	require.Len(t, events, 2, "create and patch each have exactly one audit event")
	require.True(t, events[1].Success)
	require.Equal(t, "update", events[1].Action)
}

func TestInsightsPatchSavedQueryMergesMetadataAndReplacesArrays(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "saved-queries", patchSavedQueryFixture)
	args := patchArgs(t, "saved", initial.ETag, `"patch":{"description":null,"tags":["new"],"metadata":{"obsolete":null,"team":"platform"},"parameters":[{"name":"service","type":"string","defaultValue":"worker"}]}`)
	result, err := h.c.patch(patchEditor(t), "saved-queries", args)
	require.NoError(t, err)
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(result.Document, &fields))
	require.NotContains(t, fields, "description")
	require.JSONEq(t, `["new"]`, string(fields["tags"]))
	require.JSONEq(t, `{"owner":"team","team":"platform"}`, string(fields["metadata"]))
	require.JSONEq(t, `"/brand/logo.png"`, string(fields["imageUrl"]))
	require.Contains(t, string(fields["parameters"]), "worker")
	require.Zero(t, h.queries.Load())
}

func TestInsightsPatchWidgetBatchIsAtomicAndPreservesOrder(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", patchDashboardFixture)
	before := h.puts.Load()
	bad := patchArgs(t, "demo", initial.ETag, `"patch":{"title":"Must not persist"},"widget_edits":[{"op":"update","id":"rate","patch":{"title":"Changed"}},{"op":"remove","id":"missing"}]`)
	_, err := h.c.patch(patchEditor(t), "dashboards", bad)
	require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	require.Equal(t, before, h.puts.Load())
	current, err := h.c.get(patchEditor(t), "dashboards", "demo")
	require.NoError(t, err)
	require.Equal(t, initial.ETag, current.ETag)
	good := patchArgs(t, "demo", initial.ETag, `"widget_edits":[{"op":"remove","id":"rate"},{"op":"add","widget":`+patchAddedWidget+`},{"op":"update","id":"plugin","patch":{"title":"Retained plugin"}}]`)
	result, err := h.c.patch(patchEditor(t), "dashboards", good)
	require.NoError(t, err)
	var document struct{ Widgets []struct{ ID, Title string } }
	require.NoError(t, json.Unmarshal(result.Document, &document))
	require.Equal(t, "plugin", document.Widgets[0].ID)
	require.Equal(t, "Retained plugin", document.Widgets[0].Title)
	require.Equal(t, "errors", document.Widgets[1].ID)
	require.Equal(t, before+1, h.puts.Load(), "one PUT commits all widget operations")
}

func TestInsightsPatchRejectsInvalidDocumentsWithoutChangingStorage(t *testing.T) {
	for _, tc := range []struct{ name, fields string }{
		{"required field removal", `"patch":{"title":null}`},
		{"invalid grid", `"widget_edits":[{"op":"update","id":"rate","patch":{"layout":{"w":13}}}]`},
		{"unknown option", `"widget_edits":[{"op":"update","id":"rate","patch":{"options":{"unsupported":true}}}]`},
		{"invalid added widget", `"widget_edits":[{"op":"add","widget":{"id":"new"}}]`},
		{"existing widget addition", `"widget_edits":[{"op":"add","widget":{"id":"rate"}}]`},
		{"same value", `"patch":{"title":"Service overview"}`},
		{"absent field removal", `"patch":{"unused":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newInsightsPatchHarness(t)
			initial := h.seed(t, "dashboards", patchDashboardFixture)
			_, err := h.c.patch(patchEditor(t), "dashboards", patchArgs(t, "demo", initial.ETag, tc.fields))
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
			current, err := h.c.get(patchEditor(t), "dashboards", "demo")
			require.NoError(t, err)
			require.Equal(t, initial.ETag, current.ETag)
			events := h.auditor.snapshot()
			require.Len(t, events, 2)
			require.False(t, events[1].Success)
		})
	}
}

func TestInsightsPatchRejectsAmbiguousAndMalformedArguments(t *testing.T) {
	for _, raw := range []string{
		`null`, `[]`, `{}`, `{"id":"demo","id":"other"}`, `{"ID":"demo"}`, `{"id":"demo","unknown":1}`, `{"patch":{"title":"one","title":"two"}}`,
		`{"widget_edits":null}`, `{"widget_edits":[]}`, `{"widget_edits":[null]}`, `{"widget_edits":[{"op":"add","id":"","widget":{"id":"new"}}]}`,
		`{"widget_edits":[{"op":"remove","id":"x","patch":null}]}`, `{"widget_edits":[{"op":"update","id":"x","patch":{},"widget":null}]}`,
		`{"widget_edits":[{"op":"remove","ID":"x"}]}`, `{"patch":{}} {}`, strings.Repeat(" ", insightsDashboardPatchBytes) + `{}`,
		`{"patch":` + strings.Repeat(`{"a":`, insightsPatchDepth+1) + `0` + strings.Repeat(`}`, insightsPatchDepth+1) + `}`,
	} {
		_, err := decodeInsightsPatchArgs(json.RawMessage(raw))
		if raw == `{}` {
			require.NoError(t, err, "required semantic fields are checked before any request")
			continue
		}
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), raw)
	}
}

func TestInsightsPatchRejectsImmutableFieldsAndInvalidOperationsBeforeRead(t *testing.T) {
	tag := `"` + strings.Repeat("a", 64) + `"`
	for _, tc := range []struct{ collection, fields string }{
		{"dashboards", `"patch":{}`}, {"dashboards", `"patch":null`}, {"dashboards", `"patch":[]`},
		{"dashboards", `"patch":{"id":"demo"}`}, {"dashboards", `"patch":{"schemaVersion":1}`}, {"dashboards", `"patch":{"widgets":[]}`},
		{"saved-queries", `"patch":{"providerId":"metrics"}`}, {"saved-queries", `"patch":{"kind":"metrics"}`},
		{"saved-queries", `"patch":{"name":"new"},"widget_edits":[{"op":"remove","id":"a"}]`},
		{"dashboards", `"widget_edits":[{"op":"update","id":"rate","patch":{"id":"new"}}]`},
		{"dashboards", `"widget_edits":[{"op":"remove","id":"rate"},{"op":"update","id":"rate","patch":{"title":"new"}}]`},
		{"dashboards", `"widget_edits":[{"op":"remove","id":"../bad"}]`},
	} {
		t.Run(tc.collection+tc.fields, func(t *testing.T) {
			args := patchArgs(t, "demo", tag, tc.fields)
			require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(validateInsightsPatchArgs(tc.collection, args)))
		})
	}
	args := insightsPatchArgs{ID: "demo", ETag: tag, Patch: json.RawMessage(`{"title":"New"}`)}
	for _, version := range []string{"", "*", `W/` + tag, tag + `,"other"`} {
		args.ETag = version
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(validateInsightsPatchArgs("dashboards", &args)))
	}
}

func TestInsightsPatchRejectsSizeAndEditBounds(t *testing.T) {
	tag := `"` + strings.Repeat("a", 64) + `"`
	args := insightsPatchArgs{ID: "demo", ETag: tag, Patch: json.RawMessage(`{"description":"` + strings.Repeat("x", insightsSavedQueryPatchBytes) + `"}`)}
	require.Error(t, validateInsightsPatchArgs("saved-queries", &args))
	args.Patch = nil
	for index := range insightsWidgetEditLimit + 1 {
		args.WidgetEdits = append(args.WidgetEdits, insightsWidgetEdit{Op: "remove", ID: fmt.Sprintf("widget-%d", index)})
	}
	require.Error(t, validateInsightsPatchArgs("dashboards", &args))
	for _, collection := range []string{"dashboards", "saved-queries"} {
		current := json.RawMessage(`{"id":"demo","large":"` + strings.Repeat("x", insightsPatchByteLimit(collection)-30) + `"}`)
		_, err := applyInsightsPatch(current, collection, &insightsPatchArgs{Patch: json.RawMessage(`{"new":"a much longer additional value"}`)})
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	}
}

func TestInsightsPatchRejectsStaleAndRacingWrites(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", patchDashboardFixture)
	args := patchArgs(t, "demo", initial.ETag, `"patch":{"title":"My change"}`)
	var concurrent *insightsDocumentResult
	var concurrentErr error
	concurrentDone := make(chan struct{})
	h.hookMu.Lock()
	h.afterGet = func() {
		concurrent, concurrentErr = h.c.put(patchEditor(t), "dashboards", insightsAuthoringArgs{Document: json.RawMessage(strings.Replace(patchDashboardFixture, "Service overview", "Concurrent title", 1)), ETag: initial.ETag}, false)
		close(concurrentDone)
	}
	h.hookMu.Unlock()
	_, err := h.c.patch(patchEditor(t), "dashboards", args)
	<-concurrentDone
	require.NoError(t, concurrentErr)
	require.Equal(t, connect.CodeAborted, connect.CodeOf(err))
	require.NotNil(t, concurrent)
	current, err := h.c.get(patchEditor(t), "dashboards", "demo")
	require.NoError(t, err)
	require.Equal(t, concurrent.ETag, current.ETag)
	require.Contains(t, string(current.Document), "Concurrent title")
	before := h.puts.Load()
	_, err = h.c.patch(patchEditor(t), "dashboards", args)
	require.Equal(t, connect.CodeAborted, connect.CodeOf(err))
	require.Equal(t, before, h.puts.Load(), "already stale patches never issue a PUT")
}

func TestInsightsPatchRequiresConsentHumanPermissionsAndProviderWriteValidation(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "saved-queries", patchSavedQueryFixture)
	args := patchArgs(t, "saved", initial.ETag, `"patch":{"name":"Updated"}`)
	for _, ctx := range []context.Context{
		t.Context(),
		patchPrincipal(t, []string{"editors"}, "paprika:observe"),
		patchPrincipal(t, []string{"editors"}, "paprika:insights:write"),
		patchPrincipal(t, []string{}, "paprika:observe", "paprika:insights:write"),
		patchPrincipal(t, []string{"readers"}, "paprika:observe", "paprika:insights:write"),
	} {
		before := h.puts.Load()
		_, err := h.c.patch(ctx, "saved-queries", args)
		require.Error(t, err)
		require.Equal(t, before, h.puts.Load())
	}
	// A service/provider denial after the authenticated read must remain a denial.
	h.hookMu.Lock()
	h.rejectPut = true
	h.hookMu.Unlock()
	_, err := h.c.patch(patchEditor(t), "saved-queries", args)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	current, err := h.c.get(patchEditor(t), "saved-queries", "saved")
	require.NoError(t, err)
	require.Equal(t, initial.ETag, current.ETag)
	require.Zero(t, h.queries.Load())
}

func TestInsightsPatchSavedQueryRetainsReferenceCompatibilityGuard(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "saved-queries", patchSavedQueryFixture)
	linked := strings.Replace(patchDashboardFixture, `"query":"up","unit":"req/s"`, `"query":"up","queryRef":{"id":"saved","bindings":[{"parameter":"service","source":"variable","variable":"service"}]},"unit":"req/s"`, 1)
	h.seed(t, "dashboards", linked)
	_, err := h.c.patch(patchEditor(t), "saved-queries", patchArgs(t, "saved", initial.ETag, `"patch":{"parameters":[{"name":"service","type":"number","defaultValue":1}]}`))
	require.Equal(t, connect.CodeFailedPrecondition, connect.CodeOf(err))
	current, err := h.c.get(patchEditor(t), "saved-queries", "saved")
	require.NoError(t, err)
	require.Equal(t, initial.ETag, current.ETag)
	require.Zero(t, h.queries.Load())
}
