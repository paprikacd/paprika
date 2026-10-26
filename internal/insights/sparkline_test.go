package insights

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestSparklineSettingsPersistWithSavedQueryReferences(t *testing.T) {
	for _, setting := range []struct{ name, option string }{
		{"omitted", ""}, {"disabled", `"showSparkline":false,`}, {"enabled", `"showSparkline":true,`},
	} {
		t.Run(setting.name, func(t *testing.T) {
			s, store := testService(t)
			// Missing saved definitions remain portable; a display setting must not
			// turn persistence into query execution or require a live provider.
			document := extendedDashboard(`"type":"stat","queryRef":{"id":"saved-main"},"options":{`+setting.option+`"tooltipView":{"type":"stat",`+setting.option+`"source":{"type":"saved","ref":{"id":"saved-tooltip","bindings":[{"parameter":"service","source":"label","label":"service"}]}}}}`, "")
			w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
			if w.Code != http.StatusOK {
				t.Fatalf("sparkline setting rejected: %d %s", w.Code, w.Body)
			}
			w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
			var actual, expected any
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &actual) != nil || json.Unmarshal(document, &expected) != nil || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("sparkline or reference changed through HTTP read: %d %s", w.Code, w.Body)
			}
			reopened, err := OpenStore(store.dir)
			if err != nil {
				t.Fatal(err)
			}
			persisted, _, err := reopened.Get("demo")
			if err != nil || string(persisted) != string(document) {
				t.Fatalf("sparkline setting changed after reopening store: %v", err)
			}
		})
	}
}

func TestSparklineSettingsRequireBoolean(t *testing.T) {
	for _, value := range []string{`null`, `"true"`, `0`, `1`, `[]`, `{}`} {
		t.Run(value, func(t *testing.T) {
			for _, options := range []string{
				`{"showSparkline":` + value + `}`,
				`{"tooltipView":{"type":"stat","showSparkline":` + value + `}}`,
			} {
				if err := validateDashboard("demo", extendedDashboard(`"type":"stat","options":`+options, "")); err == nil {
					t.Fatalf("non-boolean sparkline setting accepted: %s", options)
				}
			}
		})
	}
}

func TestSparklineOptionRemainsPortableAcrossVisualizationTypes(t *testing.T) {
	// Styling can survive switching visualizations; only Stat renders it.
	for _, kind := range []string{"timeseries", "bar", "table", "heatmap", "stat"} {
		if err := validateDashboard("demo", extendedDashboard(`"type":"`+kind+`","options":{"showSparkline":true,"tooltipView":{"type":"`+kind+`","showSparkline":false}}`, "")); err != nil {
			t.Errorf("display option rejected for %s: %v", kind, err)
		}
	}
}
