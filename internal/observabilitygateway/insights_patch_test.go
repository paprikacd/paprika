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
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
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
		_, _, err := applyInsightsPatch(t.Context(), current, collection, &insightsPatchArgs{Patch: json.RawMessage(`{"new":"a much longer additional value"}`)})
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

func TestInsightsPatchRejectionNamesWidgetPointer(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", patchDashboardFixture)
	args := patchArgs(t, "demo", initial.ETag, `"widget_edits":[{"op":"update","id":"rate","patch":{"layout":{"w":13}}}]`)
	_, err := h.c.patch(patchEditor(t), "dashboards", args)
	var ce *connect.Error
	require.ErrorAs(t, err, &ce)
	require.Equal(t, connect.CodeInvalidArgument, ce.Code())
	require.Len(t, ce.Details(), 1)
	message, valueErr := ce.Details()[0].Value()
	require.NoError(t, valueErr)
	report, ok := message.(*insightsv1.CheckReport)
	require.True(t, ok)
	require.Len(t, report.GetIssues(), 1)
	require.Equal(t, "/widgets/0/layout/w", report.GetIssues()[0].GetPointer())
	require.Equal(t, "rate", report.GetIssues()[0].GetWidgetId())
}

// placementDashboard is a dashboard whose grid has a gap: two full-width rows at
// y 0 and y 4, with the rows from y 2 to y 4 free.
const placementDashboard = `{"schemaVersion":1,"id":"grid","title":"Grid","timeRange":"1h","refreshInterval":0,"variables":[],"widgets":[` +
	`{"id":"top","title":"Top","type":"timeseries","providerId":"metrics","query":"up","unit":"","layout":{"x":0,"y":0,"w":12,"h":2}},` +
	`{"id":"bottom","title":"Bottom","type":"timeseries","providerId":"metrics","query":"up","unit":"","layout":{"x":0,"y":4,"w":12,"h":2}}]}`

// widgetLayout reads a widget's grid rectangle from a saved document.
func widgetLayout(t *testing.T, document json.RawMessage, id string) insightsGrid {
	t.Helper()
	var saved struct {
		Widgets []struct {
			ID     string       `json:"id"`
			Layout insightsGrid `json:"layout"`
		} `json:"widgets"`
	}
	require.NoError(t, json.Unmarshal(document, &saved))
	for _, widget := range saved.Widgets {
		if widget.ID == id {
			return widget.Layout
		}
	}
	require.Failf(t, "widget missing", "no widget %q in the saved document", id)
	return insightsGrid{}
}

func addWidget(id string, layout string) string {
	return `{"op":"add","widget":{"id":"` + id + `","title":"` + id + `","type":"stat","providerId":"metrics","query":"up","unit":"","layout":` + layout + `}}`
}

func TestInsightsPatchAddKeepsARequestedLayoutThatIsFree(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", placementDashboard)
	args := patchArgs(t, "grid", initial.ETag, `"widget_edits":[`+addWidget("side", `{"x":0,"y":2,"w":6,"h":2}`)+`]`)
	result, err := h.c.patch(patchEditor(t), "dashboards", args)
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 6, H: 2}, widgetLayout(t, result.Document, "side"))
	require.Len(t, result.Placements, 1)
	require.Equal(t, "side", result.Placements[0].ID)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 6, H: 2}, result.Placements[0].Layout)
	require.Nil(t, result.Placements[0].Requested, "a free request is not reported as moved")
}

func TestInsightsPatchAddMovesAnOverlappingWidgetToTheFirstFreeSlot(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", placementDashboard)
	// The request overlaps "top", so the first free two-row slot is in the gap at y 2.
	args := patchArgs(t, "grid", initial.ETag, `"widget_edits":[`+addWidget("gap", `{"x":0,"y":0,"w":6,"h":2}`)+`]`)
	result, err := h.c.patch(patchEditor(t), "dashboards", args)
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 6, H: 2}, widgetLayout(t, result.Document, "gap"))
	require.Len(t, result.Placements, 1)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 6, H: 2}, result.Placements[0].Layout)
	require.NotNil(t, result.Placements[0].Requested)
	require.Equal(t, insightsGrid{X: 0, Y: 0, W: 6, H: 2}, *result.Placements[0].Requested)
	// The saved grid passes the overlap rule: the save would have been refused otherwise.
	findings := insights.CheckDocument(result.Document)
	for _, finding := range findings {
		require.NotEqual(t, insightsv1.Severity_SEVERITY_ERROR, finding.GetSeverity(), finding.GetRuleId())
	}
}

func TestInsightsPatchBatchPlacesEachAddAgainstTheWidgetsBeforeIt(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", placementDashboard)
	edits := addWidget("half", `{"x":0,"y":0,"w":6,"h":2}`) + "," + addWidget("full", `{"x":0,"y":0,"w":12,"h":2}`)
	result, err := h.c.patch(patchEditor(t), "dashboards", patchArgs(t, "grid", initial.ETag, `"widget_edits":[`+edits+`]`))
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 6, H: 2}, widgetLayout(t, result.Document, "half"))
	// Once "half" fills the gap, the full-width widget cannot fit beside it or in the gap, so it lands below the grid.
	require.Equal(t, insightsGrid{X: 0, Y: 6, W: 12, H: 2}, widgetLayout(t, result.Document, "full"))
	require.Equal(t, []string{"half", "full"}, placementIDs(result.Placements))
	require.Equal(t, insightsGrid{X: 0, Y: 6, W: 12, H: 2}, result.Placements[1].Layout)
}

func TestInsightsPatchRemovedWidgetFreesItsSlotForAnAddInTheSameBatch(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", placementDashboard)
	edits := `{"op":"remove","id":"top"},` + addWidget("replacement", `{"x":0,"y":0,"w":12,"h":2}`)
	result, err := h.c.patch(patchEditor(t), "dashboards", patchArgs(t, "grid", initial.ETag, `"widget_edits":[`+edits+`]`))
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 0, Y: 0, W: 12, H: 2}, widgetLayout(t, result.Document, "replacement"))
	require.Nil(t, result.Placements[0].Requested)
}

func TestPlaceInsightsAdditionOnlyReportsReadableLayouts(t *testing.T) {
	stored := []json.RawMessage{json.RawMessage(`{"id":"a","layout":{"x":0,"y":0,"w":12,"h":2}}`)}
	// A layout that cannot be read is left for the save to reject: no move, no placement.
	widget := json.RawMessage(`{"id":"b","layout":{"x":0,"y":0,"w":12}}`)
	placed, placement, err := placeInsightsAddition(t.Context(), stored, "b", widget)
	require.NoError(t, err)
	require.Equal(t, widget, placed)
	require.Nil(t, placement)
	// A layout that runs past the twelfth column is likewise not moved.
	widget = json.RawMessage(`{"id":"c","layout":{"x":6,"y":5,"w":8,"h":2}}`)
	placed, placement, err = placeInsightsAddition(t.Context(), stored, "c", widget)
	require.NoError(t, err)
	require.Equal(t, widget, placed)
	require.Nil(t, placement)
}

func TestInsightsPatchFirstFreeSlotPreservesTheWidgetsOtherMembers(t *testing.T) {
	stored := []json.RawMessage{json.RawMessage(`{"id":"a","layout":{"x":0,"y":0,"w":12,"h":2}}`)}
	widget := json.RawMessage(`{"id":"b","title":"Exact 1.50 literal","options":{"decimals":1.50},"layout":{"x":0,"y":0,"w":4,"h":3,"extra":true}}`)
	placed, placement, err := placeInsightsAddition(t.Context(), stored, "b", widget)
	require.NoError(t, err)
	require.NotNil(t, placement)
	require.Equal(t, insightsGrid{X: 0, Y: 2, W: 4, H: 3}, placement.Layout)
	require.JSONEq(t, `{"id":"b","title":"Exact 1.50 literal","options":{"decimals":1.50},"layout":{"x":0,"y":2,"w":4,"h":3,"extra":true}}`, string(placed))
	require.Contains(t, string(placed), `"decimals":1.50`, "untouched numeric literals keep their spelling")
}

func placementIDs(placements []insightsPlacement) []string {
	ids := make([]string, 0, len(placements))
	for _, placement := range placements {
		ids = append(ids, placement.ID)
	}
	return ids
}

// halfDashboard has one widget on the left half of its first row.
const halfDashboard = `{"schemaVersion":1,"id":"half","title":"Half","timeRange":"1h","refreshInterval":0,"variables":[],"widgets":[` +
	`{"id":"a","title":"A","type":"timeseries","providerId":"metrics","query":"up","unit":"","layout":{"x":0,"y":0,"w":6,"h":2}}]}`

func TestInsightsPatchUpdatesLandBeforeAddsArePlaced(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", halfDashboard)
	// The add is listed first, but "a" moves out of the way before the add is placed,
	// so the requested rectangle is free and keeps its place.
	edits := addWidget("x", `{"x":0,"y":0,"w":6,"h":2}`) + `,{"op":"update","id":"a","patch":{"layout":{"x":6}}}`
	result, err := h.c.patch(patchEditor(t), "dashboards", patchArgs(t, "half", initial.ETag, `"widget_edits":[`+edits+`]`))
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 6, Y: 0, W: 6, H: 2}, widgetLayout(t, result.Document, "a"))
	require.Equal(t, insightsGrid{X: 0, Y: 0, W: 6, H: 2}, widgetLayout(t, result.Document, "x"))
	require.Len(t, result.Placements, 1)
	require.Nil(t, result.Placements[0].Requested, "the requested slot was free once the update ran")
}

func TestInsightsPatchRejectsLayoutsPastTheSaveBounds(t *testing.T) {
	h := newInsightsPatchHarness(t)
	initial := h.seed(t, "dashboards", halfDashboard)
	// A row or height past the save-time bounds cannot be stored, so the batch is refused
	// and the stored document keeps its revision, however the placement scan would have behaved.
	for _, edits := range []string{
		`{"op":"update","id":"a","patch":{"layout":{"h":1000000000}}},` + addWidget("x", `{"x":0,"y":0,"w":6,"h":2}`),
		`{"op":"update","id":"a","patch":{"layout":{"y":100000000}}},` + addWidget("x", `{"x":0,"y":0,"w":6,"h":2}`),
		addWidget("x", `{"x":0,"y":100000000,"w":6,"h":2}`),
	} {
		_, err := h.c.patch(patchEditor(t), "dashboards", patchArgs(t, "half", initial.ETag, `"widget_edits":[`+edits+`]`))
		require.Error(t, err, edits)
		stored, err := h.c.get(patchEditor(t), "dashboards", "half")
		require.NoError(t, err)
		require.Equal(t, initial.ETag, stored.ETag, "a refused layout must not change the stored document")
	}
}

func TestInsightsGridWithinUsesTheSaveTimeBounds(t *testing.T) {
	at := func(v int) *int { return &v }
	for _, tc := range []struct {
		name       string
		x, y, w, h int
		ok         bool
	}{
		{"largest row and height", 0, insightsMaxGridRow, 12, insightsMaxGridHeight, true},
		{"row past the bound", 0, insightsMaxGridRow + 1, 12, 2, false},
		{"height past the bound", 0, 0, 6, insightsMaxGridHeight + 1, false},
		{"past the twelfth column", 6, 0, 7, 2, false},
		{"zero width", 0, 0, 0, 2, false},
		{"negative row", 0, -1, 6, 2, false},
	} {
		_, ok := insightsGridWithin(at(tc.x), at(tc.y), at(tc.w), at(tc.h))
		require.Equal(t, tc.ok, ok, tc.name)
	}
}

func TestInsightsFirstFreeSlotStopsWhenTheRequestIsCancelled(t *testing.T) {
	occupied := make([]insightsGrid, 0, insightsMaxGridRow)
	for row := range insightsMaxGridRow {
		occupied = append(occupied, insightsGrid{X: 0, Y: row, W: insightsGridColumns, H: 1})
	}
	want := insightsGrid{X: 0, Y: 0, W: 6, H: 2}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := firstFreeInsightsSlot(ctx, occupied, want)
	require.ErrorIs(t, err, context.Canceled)
	// A live request finds the row below the grid.
	slot, err := firstFreeInsightsSlot(t.Context(), occupied, want)
	require.NoError(t, err)
	require.Equal(t, insightsGrid{X: 0, Y: insightsMaxGridRow, W: 6, H: 2}, slot)
}
