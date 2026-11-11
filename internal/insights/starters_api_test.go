package insights

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

type starterListResponse struct {
	Starters []StarterSummary `json:"starters"`
}

type starterBundleResponse struct {
	Kind          string            `json:"kind"`
	SchemaVersion int               `json:"schemaVersion"`
	Dashboards    []json.RawMessage `json:"dashboards"`
}

func TestStarterListSummarisesEveryEmbeddedStarter(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "GET", "/api/starters", nil, nil)
	if w.Code != 200 {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	var response starterListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	starters := readStarters(t)
	if len(response.Starters) != len(starters) {
		t.Fatalf("listed %d starters, embedded %d", len(response.Starters), len(starters))
	}
	for i, summary := range response.Starters {
		if summary.ID != starters[i].ID {
			t.Fatalf("starter %d is %q, want %q", i, summary.ID, starters[i].ID)
		}
		var document struct {
			Title       string            `json:"title"`
			Description string            `json:"description"`
			Widgets     []json.RawMessage `json:"widgets"`
		}
		if err := json.Unmarshal(starters[i].Document, &document); err != nil {
			t.Fatal(err)
		}
		if summary.Title != document.Title || summary.Description != document.Description {
			t.Errorf("%s: title or description differs from its document", summary.ID)
		}
		if summary.WidgetCount != len(document.Widgets) || len(summary.Tiles) != len(document.Widgets) {
			t.Errorf("%s: widget count %d and tiles %d, want %d", summary.ID, summary.WidgetCount, len(summary.Tiles), len(document.Widgets))
		}
		if len(summary.Providers) == 0 {
			t.Errorf("%s: no required provider kind is listed", summary.ID)
		}
	}
}

func TestStarterListNamesTheVariablesAndProvidersAStarterNeeds(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "GET", "/api/starters", nil, nil)
	var response starterListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	byID := map[string]StarterSummary{}
	for _, summary := range response.Starters {
		byID[summary.ID] = summary
	}
	service, ok := byID["service-overview"]
	if !ok {
		t.Fatal("service-overview is not listed")
	}
	if !slices.Equal(service.Variables, []string{"service", "namespace"}) {
		t.Errorf("service-overview variables %v", service.Variables)
	}
	if !slices.Equal(service.Providers, []string{"metrics"}) {
		t.Errorf("service-overview providers %v", service.Providers)
	}
	if control := byID["paprika-control-plane"]; len(control.Variables) != 0 {
		t.Errorf("paprika-control-plane declares no variables, got %v", control.Variables)
	}
}

func TestStarterBundleIsAPortableImportBundle(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	for _, starter := range readStarters(t) {
		w := request(t, h, "GET", "/api/starters/"+starter.ID, nil, nil)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", starter.ID, w.Code, w.Body)
		}
		if w.Header().Get("ETag") == "" {
			t.Errorf("%s: no ETag for a cacheable starter", starter.ID)
		}
		var bundle starterBundleResponse
		if err := json.Unmarshal(w.Body.Bytes(), &bundle); err != nil {
			t.Fatal(err)
		}
		if bundle.Kind != "PaprikaDashboardLibrary" || bundle.SchemaVersion != 1 {
			t.Fatalf("%s: bundle kind %q version %d", starter.ID, bundle.Kind, bundle.SchemaVersion)
		}
		if len(bundle.Dashboards) != 1 {
			t.Fatalf("%s: bundle holds %d dashboards, want exactly one", starter.ID, len(bundle.Dashboards))
		}
		if !jsonEqual(t, bundle.Dashboards[0], starter.Document) {
			t.Errorf("%s: bundled dashboard differs from the embedded document", starter.ID)
		}
		if err := validateDashboard(starter.ID, bundle.Dashboards[0]); err != nil {
			t.Errorf("%s: bundled dashboard fails validation: %v", starter.ID, err)
		}
	}
	if documents := store.List(); len(documents) != 0 {
		t.Fatalf("reading starters wrote %d dashboards", len(documents))
	}
}

func TestStarterNotFoundAndNoWriteRoute(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	w := request(t, h, "GET", "/api/starters/no-such-starter", nil, nil)
	if w.Code != 404 {
		t.Fatalf("missing starter: %d %s", w.Code, w.Body)
	}
	var failure map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil || failure["error"] == "" {
		t.Fatalf("missing starter should explain itself: %s", w.Body)
	}
	w = request(t, h, "GET", "/api/starters/..%2Fdashboards", nil, nil)
	if w.Code != 404 {
		t.Fatalf("traversal-shaped id: %d", w.Code)
	}
	// Starters are offered for review only: nothing writes them, through any method.
	for _, method := range []string{"PUT", "POST", "DELETE"} {
		w = request(t, h, method, "/api/starters/service-overview", []byte(`{}`), map[string]string{"If-None-Match": "*"})
		if w.Code == 200 || w.Code == 201 || w.Code == 204 {
			t.Fatalf("%s /api/starters/{id} succeeded with %d", method, w.Code)
		}
	}
	if documents := store.List(); len(documents) != 0 {
		t.Fatalf("starter routes wrote %d dashboards", len(documents))
	}
}

func TestStarterRoutesRequireTheSameAuthenticationAsDashboards(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	for _, path := range []string{"/api/dashboards", "/api/starters", "/api/starters/service-overview"} {
		w := request(t, h, "GET", path, nil, map[string]string{"Authorization": "Bearer invalid"})
		if w.Code != 401 {
			t.Errorf("%s with a bad token returned %d", path, w.Code)
		}
		w = request(t, h, "GET", path, nil, map[string]string{"Authorization": ""})
		if w.Code != 401 {
			t.Errorf("%s without a token returned %d", path, w.Code)
		}
	}
}

func TestStarterBundleAnswersAConditionalRead(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	first := request(t, h, "GET", "/api/starters/slo-burn-rate", nil, nil)
	tag := first.Header().Get("ETag")
	if tag == "" {
		t.Fatal("no ETag")
	}
	second := request(t, h, "GET", "/api/starters/slo-burn-rate", nil, map[string]string{"If-None-Match": tag})
	if second.Code != 304 {
		t.Fatalf("conditional read returned %d", second.Code)
	}
}

func TestServedDashboardSchemaNamesStartersAndExamplesTheSLOStarter(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "GET", "/api/schemas/dashboard", nil, nil)
	if w.Code != 200 {
		t.Fatalf("schema: %d %s", w.Code, w.Body)
	}
	if w.Body.Len() >= maxSchemaResponseBytes {
		t.Fatalf("schema response is %d bytes, at or over its %d-byte limit", w.Body.Len(), maxSchemaResponseBytes)
	}
	var response struct {
		Examples []json.RawMessage `json:"examples"`
		Notes    []string          `json:"notes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	notes := strings.Join(response.Notes, "\n")
	for _, starter := range readStarters(t) {
		if !strings.Contains(notes, starter.ID) {
			t.Errorf("schema notes do not name starter %s", starter.ID)
		}
	}
	found := false
	for _, example := range response.Examples {
		if jsonEqual(t, example, starterDocument(schemaSLOStarterID)) {
			found = true
		}
	}
	if !found {
		t.Fatal("the SLO starter is not served as a dashboard example")
	}
}

func jsonEqual(t *testing.T, a, b json.RawMessage) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return slices.Equal([]byte(mustJSON(t, x)), []byte(mustJSON(t, y)))
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
