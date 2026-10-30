package insights

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestSelectionBindingsRoundTripAndETag(t *testing.T) {
	s, _ := testService(t)
	doc := extendedDashboard(`"type":"heatmap","selectionBindings":[{"variable":"service","source":"label","value":"service"}]`, `"variables":[{"name":"service","defaultValue":"api"}]`)
	created := request(t, s.Handler(), "PUT", "/api/dashboards/demo", doc, nil)
	if created.Code != 200 || created.Header().Get("ETag") == "" {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	tag := created.Header().Get("ETag")
	changed := []byte(strings.Replace(string(doc), `"value":"service"`, `"value":"component"`, 1))
	updated := request(t, s.Handler(), "PUT", "/api/dashboards/demo", changed, map[string]string{"If-Match": tag})
	if updated.Code != 200 {
		t.Fatalf("update: %d %s", updated.Code, updated.Body)
	}
	stale := request(t, s.Handler(), "PUT", "/api/dashboards/demo", doc, map[string]string{"If-Match": tag})
	if stale.Code != 412 {
		t.Fatalf("stale ETag accepted: %d", stale.Code)
	}
	got := request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
	var expected, actual any
	if json.Unmarshal(changed, &expected) != nil || json.Unmarshal(got.Body.Bytes(), &actual) != nil || !reflect.DeepEqual(expected, actual) {
		t.Fatalf("selection binding changed: %s", got.Body)
	}
}

func TestSelectionBindingsValidation(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `[{"variable":"service","source":"label"}]`, `[{"variable":"service","source":"label","value":"service"},{"variable":"service","source":"series"}]`, `[{"variable":"service","source":"unknown"}]`} {
		if err := validateDashboard("demo", extendedDashboard(`"type":"heatmap","selectionBindings":`+raw, "")); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
