package insights

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/stretchr/testify/require"
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

func TestCompactStatPresentationValidationAndPersistence(t *testing.T) {
	s, store := testService(t)
	document := extendedDashboard(`"type":"stat","options":{"showSparkline":true,"sparklinePlacement":"side","statIcon":"network"}`, "")
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("compact presentation rejected: %d %s", w.Code, w.Body)
	}
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	persisted, _, err := reopened.Get("demo")
	if err != nil || string(persisted) != string(document) {
		t.Fatalf("compact presentation did not round-trip: %v", err)
	}
	for _, option := range []string{`"sparklinePlacement":"above"`, `"sparklinePlacement":null`, `"statIcon":"untrusted"`, `"statIcon":false`} {
		if err := validateDashboard("demo", extendedDashboard(`"type":"stat","options":{`+option+`}`, "")); err == nil {
			t.Errorf("invalid presentation accepted: %s", option)
		}
	}
}

func TestSingleRowOnlyForStats(t *testing.T) {
	for _, kind := range []string{"stat", "timeseries", "bar", "table", "traces", "heatmap"} {
		document := extendedDashboard(`"type":"`+kind+`"`, "")
		var raw map[string]any
		if err := json.Unmarshal(document, &raw); err != nil {
			t.Fatal(err)
		}
		widgets, ok := raw["widgets"].([]any)
		if !ok || len(widgets) == 0 {
			t.Fatal("fixture widgets missing")
		}
		widget, ok := widgets[0].(map[string]any)
		if !ok {
			t.Fatal("fixture widget is not an object")
		}
		layout, ok := widget["layout"].(map[string]any)
		if !ok {
			t.Fatal("fixture layout is not an object")
		}
		layout["h"] = 1
		encoded, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		err = validateDashboard("demo", encoded)
		if (err == nil) != (kind == "stat") {
			t.Errorf("type %s with height 1: %v", kind, err)
		}
	}
}

func TestStatValueBarRequiresExplicitScale(t *testing.T) {
	for _, options := range []string{`{"showStatBar":true,"min":0,"max":100}`, `{"showStatBar":false}`, `{}`} {
		require.NoError(t, validateDashboard("demo", extendedDashboard(`"type":"stat","options":`+options, "")), options)
	}
	for _, options := range []string{`{"showStatBar":true}`, `{"showStatBar":true,"min":0}`, `{"showStatBar":true,"max":100}`, `{"showStatBar":true,"min":5,"max":5}`, `{"showStatBar":"yes","min":0,"max":100}`, `{"showStatBar":null}`, `{"showStatBar":true,"min":null,"max":100}`} {
		require.Error(t, validateDashboard("demo", extendedDashboard(`"type":"stat","options":`+options, "")), options)
	}
}
