package insights

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func queryParameter(name, kind string, defaults ...any) map[string]any {
	parameter := map[string]any{"name": name, "type": kind}
	if len(defaults) > 0 {
		parameter["defaultValue"] = defaults[0]
	}
	return parameter
}

func referenceDashboard(t *testing.T, id, location string, bindings []any) []byte {
	t.Helper()
	var document map[string]any
	_ = json.Unmarshal(dashboard(id, "Existing dashboard"), &document)
	document["variables"] = []any{map[string]any{"name": "service", "defaultValue": "api"}}
	widget := testFixtureObject(t, document, "widgets", 0)
	widget["title"] = "Existing widget"
	ref := map[string]any{"id": "query"}
	if bindings != nil {
		ref["bindings"] = bindings
	}
	if location == "tooltip" {
		widget["options"] = map[string]any{"tooltipView": map[string]any{"type": "stat", "source": map[string]any{"type": "saved", "ref": ref}}}
	} else {
		widget["queryRef"] = ref
	}
	return savedQueryJSON(t, document)
}

func TestSavedQueryReplacementProtectsExistingReferences(t *testing.T) {
	text := []any{queryParameter("value", "string", "default")}
	number := []any{queryParameter("value", "number", 1)}
	cases := []struct {
		name     string
		before   []any
		after    []any
		bindings []any
		status   int
		onlyTip  bool
	}{
		{"removed bound parameter", text, []any{}, []any{map[string]any{"parameter": "value", "source": "variable", "variable": "service"}}, 409, false},
		{"new required parameter", text, []any{queryParameter("value", "string", "default"), queryParameter("new", "string")}, nil, 409, false},
		{"removed implicit default", text, []any{queryParameter("value", "string")}, nil, 409, false},
		{"variable type change", text, number, []any{map[string]any{"parameter": "value", "source": "variable", "variable": "service"}}, 409, false},
		{"label type change", text, number, []any{map[string]any{"parameter": "value", "source": "label", "label": "service"}}, 409, true},
		{"fixed number to text", number, text, []any{map[string]any{"parameter": "value", "source": "constant", "value": 42}}, 409, false},
		{"fixed text to number", text, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": "api"}}, 409, false},
		{"fixed numeric string", text, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": "-7.25e+2"}}, 200, false},
		{"fixed leading-zero string", text, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": "07"}}, 409, false},
		{"fixed whitespace string", text, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": " 7 "}}, 409, false},
		{"fixed infinite numeric string", text, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": "1e999"}}, 409, false},
		{"value field needs number", number, text, []any{map[string]any{"parameter": "value", "source": "field", "field": "value"}}, 409, true},
		{"timestamp field needs number", number, text, []any{map[string]any{"parameter": "value", "source": "field", "field": "timestamp"}}, 409, true},
		{"series field needs text", text, number, []any{map[string]any{"parameter": "value", "source": "field", "field": "series"}}, 409, true},
		{"fix existing field type", text, number, []any{map[string]any{"parameter": "value", "source": "field", "field": "value"}}, 200, true},
		{"bound default can be removed", text, []any{queryParameter("value", "string")}, []any{map[string]any{"parameter": "value", "source": "constant", "value": "api"}}, 200, false},
		{"unbound parameter can be removed", text, []any{}, nil, 200, false},
		{"optional parameter can be added", text, []any{queryParameter("value", "string", "default"), queryParameter("new", "number", 42)}, nil, 200, false},
		{"implicit default can change type", text, number, nil, 200, false},
		{"preexisting unknown binding survives harmless edit", text, text, []any{map[string]any{"parameter": "missing", "source": "constant", "value": "x"}}, 200, false},
		{"preexisting missing required survives harmless edit", []any{queryParameter("value", "string")}, []any{queryParameter("value", "string")}, nil, 200, false},
		{"preexisting bad constant survives harmless edit", number, number, []any{map[string]any{"parameter": "value", "source": "constant", "value": "api"}}, 200, false},
		{"preexisting error does not hide new required parameter", []any{queryParameter("value", "string")}, []any{queryParameter("value", "string"), queryParameter("new", "number")}, nil, 409, false},
	}
	for _, tc := range cases {
		for _, location := range []string{"query", "tooltip"} {
			if tc.onlyTip && location != "tooltip" {
				continue
			}
			t.Run(tc.name+"/"+location, func(t *testing.T) {
				s, store := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics:9090"})
				document := savedQueryDocument("query")
				document["query"], document["parameters"] = "up", tc.before
				original := savedQueryJSON(t, document)
				created := request(t, s.Handler(), "PUT", "/api/saved-queries/query", original, map[string]string{"If-None-Match": "*"})
				if created.Code != 200 {
					t.Fatalf("create: %d %s", created.Code, created.Body)
				}
				// Persist the reference through the real HTTP API: unresolved refs are
				// intentionally valid documents, including the preexisting error cases.
				board := request(t, s.Handler(), "PUT", "/api/dashboards/existing", referenceDashboard(t, "existing", location, tc.bindings), map[string]string{"If-None-Match": "*"})
				if board.Code != 200 {
					t.Fatalf("save dashboard: %d %s", board.Code, board.Body)
				}
				document["name"], document["query"], document["parameters"] = "Replaced query", "up + 1", tc.after
				replacement := savedQueryJSON(t, document)
				updated := request(t, s.Handler(), "PUT", "/api/saved-queries/query", replacement, map[string]string{"If-Match": created.Header().Get("ETag")})
				if updated.Code != tc.status {
					t.Fatalf("replace: got %d want %d: %s", updated.Code, tc.status, updated.Body)
				}
				if tc.status == 409 && (!strings.Contains(updated.Body.String(), "Existing dashboard") || !strings.Contains(updated.Body.String(), "Existing widget") || !strings.Contains(updated.Body.String(), location)) {
					t.Fatalf("conflict must identify the impacted reference: %s", updated.Body)
				}
				want := original
				if tc.status == 200 {
					want = replacement
				}
				stored := request(t, s.Handler(), "GET", "/api/saved-queries/query", nil, nil)
				if stored.Code != 200 || !bytes.Equal(bytes.TrimSpace(stored.Body.Bytes()), want) {
					t.Fatalf("persisted state after replace: %d %s", stored.Code, stored.Body)
				}
				// Reopen the durable query store; failure must not write a replacement
				// to disk, and successful replacement must survive process restart.
				reopened, err := openSavedQueryStore(store.dir)
				if err != nil {
					t.Fatal(err)
				}
				persisted, _, err := reopened.get("query")
				if err != nil || !bytes.Equal(persisted, want) {
					t.Fatalf("restart mismatch: %s %v", persisted, err)
				}
			})
		}
	}
}

func TestSavedQueryReplacementChecksPreconditionsBeforeCompatibility(t *testing.T) {
	s, store := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics:9090"})
	document := savedQueryDocument("query")
	document["query"], document["parameters"] = "up", []any{queryParameter("value", "string", "default")}
	w := request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), nil)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	initialTag := w.Header().Get("ETag")
	if _, err := store.Put("existing", referenceDashboard(t, "existing", "tooltip", []any{map[string]any{"parameter": "value", "source": "label", "label": "service"}}), "", ""); err != nil {
		t.Fatal(err)
	}
	document["parameters"] = []any{queryParameter("value", "number", 1)}
	for _, headers := range []map[string]string{{"If-Match": `"stale"`}, {"If-None-Match": "*"}} {
		w = request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), headers)
		if w.Code != 412 {
			t.Fatalf("precondition %v: %d %s", headers, w.Code, w.Body)
		}
	}
	// A caller cannot bypass the reference guard with last-write-wins or *.
	for _, headers := range []map[string]string{nil, {"If-Match": "*"}, {"If-Match": initialTag}} {
		w = request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), headers)
		if w.Code != 409 {
			t.Fatalf("compatibility %v: %d %s", headers, w.Code, w.Body)
		}
	}
	// Removing the impacted reference is an explicit repair, then replacement
	// can succeed using the same still-current ETag.
	if err := store.Delete("existing", ""); err != nil {
		t.Fatal(err)
	}
	w = request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), map[string]string{"If-Match": initialTag})
	if w.Code != 200 {
		t.Fatalf("replace after reference repair: %d %s", w.Code, w.Body)
	}
}

func TestSavedQueryReplacementConcurrentHTTPWritersPreserveReferences(t *testing.T) {
	s, store := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics:9090"})
	document := savedQueryDocument("query")
	document["query"], document["parameters"] = "up", []any{queryParameter("value", "string", "api")}
	created := request(t, s.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), map[string]string{"If-None-Match": "*"})
	if created.Code != 200 {
		t.Fatal(created.Body)
	}
	for _, location := range []string{"query", "tooltip"} {
		binding := map[string]any{"parameter": "value", "source": "variable", "variable": "service"}
		if location == "tooltip" {
			binding = map[string]any{"parameter": "value", "source": "label", "label": "service"}
		}
		if _, err := store.Put(location, referenceDashboard(t, location, location, []any{binding}), "", "*"); err != nil {
			t.Fatal(err)
		}
	}
	type result struct {
		invalid bool
		code    int
	}
	results := make(chan result, 16)
	start := make(chan struct{})
	var writers sync.WaitGroup
	for i := range 16 {
		candidate := savedQueryDocument("query")
		candidate["name"], candidate["query"] = fmt.Sprintf("Writer %d", i), "up"
		invalid := i%2 == 0
		candidate["parameters"] = []any{queryParameter("value", "string", "api")}
		if invalid {
			candidate["parameters"] = []any{queryParameter("value", "number", 42)}
		}
		raw := savedQueryJSON(t, candidate)
		writers.Add(1)
		go func() {
			defer writers.Done()
			<-start
			response := request(t, s.Handler(), "PUT", "/api/saved-queries/query", raw, map[string]string{"If-Match": created.Header().Get("ETag")})
			results <- result{invalid, response.Code}
		}()
	}
	close(start)
	writers.Wait()
	close(results)
	winners := 0
	for result := range results {
		if result.invalid {
			if result.code != 409 && result.code != 412 {
				t.Fatalf("incompatible concurrent writer: %d", result.code)
			}
		} else if result.code == 200 {
			winners++
		} else if result.code != 412 {
			t.Fatalf("compatible concurrent writer: %d", result.code)
		}
	}
	if winners != 1 {
		t.Fatalf("conditional replacement winners: %d, want 1", winners)
	}
	persisted, _, err := s.savedQueries.get("query")
	var final SavedQuery
	if err != nil || json.Unmarshal(persisted, &final) != nil || len(final.Parameters) != 1 || final.Parameters[0].Type != "string" {
		t.Fatalf("incompatible contract persisted: %s %v", persisted, err)
	}
}
