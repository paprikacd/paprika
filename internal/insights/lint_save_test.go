package insights

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// overlappingDocument is schema-valid and has one error-severity lint finding.
func overlappingDocument(id string) Dashboard {
	return documentWithWidgets(id,
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
	)
}

// warningDocument is schema-valid and has only warning-severity lint findings.
func warningDocument(id string) Dashboard {
	return documentWithWidgets(id, widgetJSON("a", `{"x":0,"y":0,"w":4,"h":2}`, `"type":"stat","options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}`))
}

type savedBody struct {
	Error     string           `json:"error"`
	Issues    []map[string]any `json:"issues"`
	Total     uint32           `json:"total"`
	Truncated bool             `json:"truncated"`
}

func TestSaveRejectsOverlapOnCreateAndUpdate(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()

	created := request(t, h, "PUT", "/api/dashboards/demo", overlappingDocument("demo"), map[string]string{"If-None-Match": "*"})
	if created.Code != http.StatusBadRequest {
		t.Fatalf("overlapping create status = %d, body %s", created.Code, created.Body)
	}
	var body savedBody
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// A document with an overlap reports no holes: the cells the push-down leaves are
	// its effect, so the overlap is the only finding.
	if body.Error != `"Widget b" (b) overlaps "Widget a" (a)` || body.Total != 1 || body.Truncated || len(body.Issues) != 1 {
		t.Fatalf("rejected create body = %+v", body)
	}
	issue := body.Issues[0]
	if issue["ruleId"] != "layout.overlap" || issue["severity"] != "SEVERITY_ERROR" || issue["source"] != "SOURCE_LINT" || issue["pointer"] != "/widgets/1/layout" || issue["widgetId"] != "b" {
		t.Fatalf("overlap issue = %v", issue)
	}
	if _, _, err := store.Get("demo"); err == nil {
		t.Fatal("rejected create persisted a document")
	}

	clean := dashboard("demo", "Clean")
	if w := request(t, h, "PUT", "/api/dashboards/demo", clean, map[string]string{"If-None-Match": "*"}); w.Code != http.StatusOK {
		t.Fatalf("clean create status = %d, body %s", w.Code, w.Body)
	}
	_, etag, err := store.Get("demo")
	if err != nil {
		t.Fatal(err)
	}
	update := request(t, h, "PUT", "/api/dashboards/demo", overlappingDocument("demo"), map[string]string{"If-Match": etag})
	if update.Code != http.StatusBadRequest {
		t.Fatalf("overlapping update status = %d, body %s", update.Code, update.Body)
	}
	stored, _, err := store.Get("demo")
	if err != nil || !strings.Contains(string(stored), `"Clean"`) {
		t.Fatalf("rejected update changed the stored document: %s %v", stored, err)
	}
}

// A document saved before the rule existed, with overlapping widgets, must still
// load and be readable. Lint runs on the write path only.
func TestLegacyOverlappingDocumentStillLoads(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "legacy.json"), overlappingDocument("legacy"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("open store with a legacy overlapping document: %v", err)
	}
	s, err := NewServer(Config{Token: testToken}, store)
	if err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	read := request(t, h, "GET", "/api/dashboards/legacy", nil, nil)
	if read.Code != http.StatusOK {
		t.Fatalf("read of a legacy overlapping document = %d, body %s", read.Code, read.Body)
	}
	list := request(t, h, "GET", "/api/dashboards", nil, nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list with a legacy overlapping document = %d", list.Code)
	}
}

func TestSuccessfulSaveReturnsWarningsInChecks(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := warningDocument("demo")
	w := request(t, h, "PUT", "/api/dashboards/demo?checks=true", document, map[string]string{"If-None-Match": "*"})
	if w.Code != http.StatusOK {
		t.Fatalf("warning-only save status = %d, body %s", w.Code, w.Body)
	}
	var saved map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	var checks struct {
		Issues    []map[string]any `json:"issues"`
		Total     uint32           `json:"total"`
		Truncated bool             `json:"truncated"`
	}
	if err := json.Unmarshal(saved["checks"], &checks); err != nil {
		t.Fatalf("checks = %s: %v", saved["checks"], err)
	}
	// A compact stat that stacks a bar on a sparkline fires stat.density alone: the
	// two stat rules cover disjoint cases.
	if checks.Total != 1 || checks.Truncated || len(checks.Issues) != 1 || checks.Issues[0]["ruleId"] != "stat.density" || checks.Issues[0]["severity"] != "SEVERITY_WARNING" {
		t.Fatalf("checks = %+v", checks)
	}

	// Everything except checks is the document as it was submitted.
	delete(saved, "checks")
	var want, got map[string]any
	if err := json.Unmarshal(document, &want); err != nil {
		t.Fatal(err)
	}
	rest, err := json.Marshal(saved)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(rest, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("success body changed the document:\nwant %v\ngot  %v", want, got)
	}
}

func TestCleanSaveReturnsAnEmptyChecksFieldWhenAsked(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo?checks=true", dashboard("demo", "Demo"), map[string]string{"If-None-Match": "*"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if !strings.HasSuffix(strings.TrimSpace(w.Body.String()), `,"checks":{"issues":[],"total":0,"truncated":false,"errorCount":0,"warningCount":0,"infoCount":0}}`) {
		t.Fatalf("body = %s", w.Body)
	}
}

// Without the request for checks, the success body is the document exactly as
// before, even when the document has warnings. Clients that store the body
// therefore never send back a checks member.
func TestDefaultSaveBodyIsTheDocumentWithoutChecks(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := warningDocument("demo")
	w := request(t, h, "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), `"checks"`) {
		t.Fatalf("default body carries checks: %s", w.Body)
	}
	var got, want map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(document, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("default body differs from the document:\nwant %v\ngot  %v", want, got)
	}
	// The stored document can be saved back unchanged, which the gateway does.
	if again := request(t, h, "PUT", "/api/dashboards/demo", w.Body.Bytes(), map[string]string{"If-Match": w.Header().Get("ETag")}); again.Code != http.StatusOK {
		t.Fatalf("saving the returned body back = %d, body %s", again.Code, again.Body)
	}
}

// The dry run reports lint findings with the schema findings, and writes nothing.
func TestDryRunReportsLintFindings(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	w := request(t, h, "POST", "/api/dashboards/validate", checkBody(overlappingDocument("demo")), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("dry run status = %d, body %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), `"ruleId":"layout.overlap"`) || !strings.Contains(w.Body.String(), `"message":"\"Widget b\" (b) overlaps \"Widget a\" (a)"`) {
		t.Fatalf("dry run = %s", w.Body)
	}
	if got := store.List(); len(got) != 0 {
		t.Fatalf("dry run wrote %d documents", len(got))
	}
}

// A document with a schema error is reported by the schema rules alone; lint
// does not read a document the schema has rejected.
func TestSchemaFailureSkipsLint(t *testing.T) {
	document := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, `"unknownField":true`),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
	)
	findings := saveFindings("demo", document)
	for _, finding := range findings {
		if finding.GetSource() != insightsv1.Source_SOURCE_SCHEMA {
			t.Fatalf("lint ran on a schema-invalid document: %v", finding)
		}
	}
}
