package insights

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSavedQueryRichMetadataBounds(t *testing.T) {
	invalid := []map[string]any{
		{"imageUrl": nil}, {"imageUrl": ""}, {"imageUrl": "http://images.example.com/a.png"},
		{"imageUrl": "//images.example.com/a.png"}, {"imageUrl": "https:///images.example.com/a.png"},
		{"imageUrl": "data:image/png;base64,aA=="}, {"imageUrl": "javascript:alert(1)"},
		{"imageUrl": "https://user:password@images.example.com/a.png"}, {"imageUrl": "https://@images.example.com/a.png"}, //nolint:gosec // G101: fake userinfo verifies credential-bearing image URLs are rejected.
		{"imageUrl": "https://images.example.com:65536/a.png"}, {"imageUrl": "https://images.example.com/a\nb.png"},
		{"imageUrl": "/\\images.example.com/a.png"}, {"imageUrl": strings.Repeat("/a", 1025)},
		{"tags": nil}, {"tags": "production"}, {"tags": []any{nil}}, {"tags": []string{""}}, {"tags": []string{" production"}},
		{"tags": []string{"production", "production"}}, {"tags": []string{strings.Repeat("x", 33)}}, {"tags": []string{strings.Repeat("🫑", 17)}},
		{"tags": []string{"1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"}},
		{"metadata": nil}, {"metadata": []any{}}, {"metadata": map[string]any{"team": nil}}, {"metadata": map[string]any{"team": 4}},
		{"metadata": map[string]string{"": "empty"}}, {"metadata": map[string]string{"team ": "platform"}},
		{"metadata": map[string]string{strings.Repeat("k", 65): "value"}}, {"metadata": map[string]string{"team": strings.Repeat("x", 257)}},
		{"metadata": map[string]string{"constructor": "reserved"}}, {"metadata": map[string]string{"__proto__": "reserved"}},
		{"metadata": map[string]string{"1": "", "2": "", "3": "", "4": "", "5": "", "6": "", "7": "", "8": "", "9": "", "10": "", "11": "", "12": "", "13": ""}},
	}
	for _, patch := range invalid {
		raw := savedQueryJSON(t, patch)
		t.Run(string(raw), func(t *testing.T) {
			document := savedQueryDocument("query")
			for key, value := range patch {
				document[key] = value
			}
			if _, err := validateSavedQuery("query", savedQueryJSON(t, document)); err == nil {
				t.Fatal("invalid saved query library metadata accepted")
			}
		})
	}
	for _, imageURL := range []string{"/images/cover.png", "/images/cover.svg?size=80", "https://images.example.com:443/cover.png", "https://[::1]/cover.png"} {
		document := savedQueryDocument("query")
		document["imageUrl"] = imageURL
		document["tags"] = []string{strings.Repeat("🫑", 16)}
		document["metadata"] = map[string]string{strings.Repeat("🫑", 32): strings.Repeat("🫑", 128)}
		if _, err := validateSavedQuery("query", savedQueryJSON(t, document)); err != nil {
			t.Fatalf("valid boundary metadata rejected: %v", err)
		}
	}
}

func TestSavedQueryRichMetadataPersistence(t *testing.T) {
	provider := ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://metrics.internal:9090"}
	s, store := testService(t, provider)
	document := savedQueryDocument("query")
	document["description"] = "Availability of production services"
	document["imageUrl"] = "https://images.example.com/cover.png"
	document["tags"] = []string{"production", "availability"}
	document["metadata"] = map[string]string{"team": "platform", "runbook": "https://docs.example.com/availability"}
	raw := savedQueryJSON(t, document)
	w := request(t, s.Handler(), "PUT", "/api/saved-queries/query", raw, map[string]string{"If-None-Match": "*"})
	if w.Code != 200 {
		t.Fatalf("save rich metadata: %d %s", w.Code, w.Body)
	}
	tag := w.Header().Get("ETag")
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{provider}}, reopened)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := validateSavedQuery("query", raw)
	if err != nil {
		t.Fatal(err)
	}
	w = request(t, restarted.Handler(), "GET", "/api/saved-queries/query", nil, nil)
	var actual SavedQuery
	if w.Code != 200 || w.Header().Get("ETag") != tag || json.Unmarshal(w.Body.Bytes(), &actual) != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("rich metadata did not survive restart: %d %s", w.Code, w.Body)
	}
	w = request(t, restarted.Handler(), "GET", "/api/saved-queries", nil, nil)
	var result struct{ Queries []SavedQuery }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Queries) != 1 || !reflect.DeepEqual(result.Queries[0], expected) {
		t.Fatalf("library list dropped rich metadata: %d %s", w.Code, w.Body)
	}
	delete(document, "imageUrl")
	document["tags"], document["metadata"] = []string{}, map[string]string{}
	w = request(t, restarted.Handler(), "PUT", "/api/saved-queries/query", savedQueryJSON(t, document), map[string]string{"If-Match": tag})
	if w.Code != 200 {
		t.Fatalf("clear rich metadata: %d %s", w.Code, w.Body)
	}
}
