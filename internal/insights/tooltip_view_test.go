package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTooltipViewPersistsThroughService(t *testing.T) {
	s, _ := testService(t)
	for _, view := range []string{
		`{"type":"timeseries"}`,
		`{"type":"timeseries","height":120,"showGrid":false,"showAxis":true}`,
		`{"type":"timeseries","height":160,"showGrid":true,"showAxis":false}`,
		`{"type":"timeseries","height":200,"showGrid":false,"showAxis":false}`,
		`{"type":"bar","height":320,"showLegend":false,"title":"Latency","unit":"ms","color":"#123aBC","decimals":8,"source":{"type":"series"}}`,
		`{"type":"stat","source":{"type":"query","providerId":"portable-metrics","query":"requests{service={{service}}}","bindings":[{"variable":"service","label":"service.name"}]}}`,
		`{"type":"table","source":{"type":"series"}}`,
		`{"type":"heatmap"}`,
		`{"type":"traces","source":{"type":"query","providerId":"portable-tempo","query":"{ resource.service.name = {{service}} }","bindings":[{"variable":"service","label":"service"}]}}`,
		`{"type":"plugin","pluginId":"threshold-gauge","dataKind":"metrics","config":{"label":"Gauge","minimum":0,"maximum":100}}`,
		`{"type":"plugin","pluginId":"custom-traces","dataKind":"traces","source":{"type":"query","providerId":"portable-tempo","query":"{}"},"config":{"nested":{"safe":[null,true,2,"value"]}}}`,
	} {
		document := extendedDashboard(`"type":"heatmap","options":{"tooltipView":`+view+`}`, "")
		w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
		if w.Code != 200 {
			t.Fatalf("valid tooltip rejected: %d %s", w.Code, w.Body)
		}
		w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
		var decoded struct {
			Widgets []struct {
				Options struct {
					TooltipView json.RawMessage `json:"tooltipView"`
				} `json:"options"`
			} `json:"widgets"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &decoded); err != nil {
			t.Fatal(err)
		}
		var actual, expected any
		_ = json.Unmarshal(decoded.Widgets[0].Options.TooltipView, &actual)
		_ = json.Unmarshal([]byte(view), &expected)
		a, _ := json.Marshal(actual)
		e, _ := json.Marshal(expected)
		if string(a) != string(e) {
			t.Fatalf("tooltip settings lost: got %s, want %s", a, e)
		}
	}
}

func TestTooltipViewRejectsUnsupportedOrUnboundedDefinitions(t *testing.T) {
	for _, view := range []string{
		`null`, `[]`, `{}`, `{"type":"unknown"}`, `{"type":null}`,
		`{"type":"timeseries","height":121}`, `{"type":"timeseries","height":"160"}`,
		`{"type":"timeseries","height":null}`, `{"type":"timeseries","height":1e400}`,
		`{"type":"timeseries","showAxis":"yes"}`, `{"type":"timeseries","showGrid":null}`,
		`{"type":"timeseries","query":"up"}`, `{"type":"timeseries","providerId":"metrics"}`,
		`{"type":"timeseries","tooltipView":{"type":"timeseries"}}`,
		`{"type":"timeseries","options":{"tooltipView":{"type":"timeseries"}}}`,
		`{"type":"timeseries","showLegend":1}`, `{"type":"timeseries","showLegend":null}`,
		`{"type":"stat","decimals":-1}`, `{"type":"stat","decimals":9}`, `{"type":"stat","decimals":1.5}`, `{"type":"stat","decimals":1e400}`,
		`{"type":"stat","title":1}`, `{"type":"stat","unit":false}`, `{"type":"stat","color":"red"}`, `{"type":"stat","color":"#123"}`,
		`{"type":"stat","title":""}`, `{"type":"stat","title":"  "}`,
		`{"type":"traces"}`, `{"type":"traces","source":{"type":"series"}}`,
		`{"type":"plugin"}`, `{"type":"plugin","pluginId":"https://evil","dataKind":"metrics"}`,
		`{"type":"plugin","pluginId":"custom","dataKind":"other"}`, `{"type":"plugin","pluginId":"custom","dataKind":"traces"}`,
		`{"type":"plugin","pluginId":"custom","dataKind":"metrics","config":[]}`,
		`{"type":"plugin","pluginId":"custom","dataKind":"metrics","config":{"__proto__":{}}}`,
		`{"type":"stat","pluginId":"custom"}`, `{"type":"stat","dataKind":"metrics"}`, `{"type":"stat","config":{}}`,
		`{"type":"stat","source":null}`, `{"type":"stat","source":[]}`, `{"type":"stat","source":{}}`,
		`{"type":"stat","source":{"type":"series","providerId":"metrics"}}`,
		`{"type":"stat","source":{"type":"query"}}`,
		`{"type":"stat","source":{"type":"query","providerId":"https://evil","query":"up"}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"  "}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":12}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","url":"http://evil"}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":null}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":{}}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":[{"variable":"service","label":""}]}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":[{"variable":"service","label":12}]}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":[{"variable":"constructor","label":"service"}]}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":[{"variable":"service","label":"one"},{"variable":"service","label":"two"}]}}`,
		`{"type":"stat","source":{"type":"query","providerId":"metrics","query":"up","bindings":[{"variable":"service","label":"one","value":"injection"}]}}`,
	} {
		if err := validateDashboard("demo", extendedDashboard(`"type":"heatmap","options":{"tooltipView":`+view+`}`, "")); err == nil {
			t.Errorf("invalid tooltip accepted: %s", view)
		}
	}
}

func TestTooltipViewBoundsAndPersistenceAfterRestart(t *testing.T) {
	bindings := make([]map[string]string, 20)
	for index := range bindings {
		bindings[index] = map[string]string{"variable": fmt.Sprintf("label_%d", index), "label": strings.Repeat("😀", 64)}
	}
	view := map[string]any{
		"type": "plugin", "pluginId": "custom", "dataKind": "metrics", "height": 320,
		"title": strings.Repeat("😀", 60), "unit": strings.Repeat("😀", 12),
		"source": map[string]any{"type": "query", "providerId": "portable-metrics", "query": strings.Repeat("x", 8192), "bindings": bindings},
		"config": map[string]any{"label": strings.Repeat("x", 16*1024-12)},
	}
	encode := func(value any) []byte {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	viewJSON := encode(view)
	document := extendedDashboard(`"type":"heatmap","options":{"tooltipView":`+string(viewJSON)+`}`, "")
	s, store := testService(t)
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if w.Code != 200 {
		t.Fatalf("boundary settings rejected: %d %s", w.Code, w.Body)
	}
	reopened, err := OpenStore(store.dir)
	if err != nil {
		t.Fatal(err)
	}
	persisted, _, err := reopened.Get("demo")
	if err != nil || string(persisted) != string(document) {
		t.Fatalf("settings changed after restart: %v", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"title": func(v map[string]any) { v["title"] = strings.Repeat("😀", 61) },
		"unit":  func(v map[string]any) { v["unit"] = strings.Repeat("😀", 13) },
		"query": func(v map[string]any) {
			testFixtureValue[map[string]any](t, v["source"])["query"] = strings.Repeat("x", 8193)
		},
		"binding count": func(v map[string]any) {
			testFixtureValue[map[string]any](t, v["source"])["bindings"] = append(bindings, map[string]string{"variable": "extra", "label": "service"})
		},
		"label length": func(v map[string]any) {
			testFixtureValue[map[string]any](t, v["source"])["bindings"] = []map[string]string{{"variable": "service", "label": strings.Repeat("😀", 65)}}
		},
		"variable length": func(v map[string]any) {
			testFixtureValue[map[string]any](t, v["source"])["bindings"] = []map[string]string{{"variable": strings.Repeat("x", 65), "label": "service"}}
		},
		"config bytes": func(v map[string]any) { v["config"] = map[string]any{"label": strings.Repeat("x", 16*1024)} },
		"config depth": func(v map[string]any) {
			var nested any = true
			for i := 0; i < 9; i++ {
				nested = map[string]any{"child": nested}
			}
			v["config"] = nested
		},
	} {
		t.Run(name, func(t *testing.T) {
			var cloned map[string]any
			if err := json.Unmarshal(viewJSON, &cloned); err != nil {
				t.Fatal(err)
			}
			mutate(cloned)
			if err := validateTooltipView(encode(cloned)); err == nil {
				t.Fatal("out-of-bounds tooltip accepted")
			}
		})
	}
}

func TestTooltipQuerySourceUsesExistingProviderCapabilityBoundary(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	// Portable definitions retain provider references; execution enforces actual
	// installed capabilities and never forwards a mismatched query upstream.
	document := extendedDashboard(`"type":"heatmap","options":{"tooltipView":{"type":"traces","source":{"type":"query","providerId":"metrics","query":"{}"}}}`, "")
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if w.Code != 200 {
		t.Fatalf("portable tooltip definition rejected: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "POST", "/api/query", []byte(`{"providerId":"metrics","kind":"traces","query":"{}","start":1700000000,"end":1700000600,"step":30}`), nil)
	if w.Code != 400 || calls.Load() != 0 {
		t.Fatalf("mismatched tooltip query reached upstream: status=%d calls=%d", w.Code, calls.Load())
	}
}

func TestTooltipObservationBindingsPersistForAllHosts(t *testing.T) {
	bindings := `[{"variable":"service","label":"service.name"},{"variable":"observed","field":"value"},{"variable":"at","field":"timestamp"},{"variable":"signal","field":"series"}]`
	view := `{"type":"stat","source":{"type":"query","providerId":"portable-metrics","query":"metric{service={{service}},signal={{signal}}} @ {{at}} > {{observed}}","bindings":` + bindings + `}}`
	for _, host := range []string{"timeseries", "bar", "table", "heatmap"} {
		t.Run(host, func(t *testing.T) {
			s, store := testService(t)
			document := extendedDashboard(`"type":"`+host+`","options":{"tooltipView":`+view+`}`, "")
			w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
			if w.Code != http.StatusOK {
				t.Fatalf("valid mixed bindings rejected: %d %s", w.Code, w.Body)
			}
			w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
			var actual, expected any
			if json.Unmarshal(w.Body.Bytes(), &actual) != nil || json.Unmarshal(document, &expected) != nil || w.Code != http.StatusOK || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("bindings changed through service read: %d %s", w.Code, w.Body)
			}
			reopened, err := OpenStore(store.dir)
			if err != nil {
				t.Fatal(err)
			}
			persisted, _, err := reopened.Get("demo")
			if err != nil || string(persisted) != string(document) {
				t.Fatalf("observation bindings changed after restart: %v", err)
			}
		})
	}
}

func TestTooltipObservationBindingsRejectAmbiguousSources(t *testing.T) {
	for _, bindings := range []string{
		`[{"variable":"service"}]`,
		`[{"variable":"service","label":"service","field":"series"}]`,
		`[{"variable":"service","label":"service","field":null}]`,
		`[{"variable":"service","label":null,"field":"series"}]`,
		`[{"variable":"value","field":null}]`,
		`[{"variable":"value","field":1}]`,
		`[{"variable":"value","field":""}]`,
		`[{"variable":"value","field":"latest"}]`,
		`[{"variable":"value","field":"Value"}]`,
		`[{"variable":"value","field":"value","extra":true}]`,
		`[{"variable":"__proto__","field":"value"}]`,
		`[{"variable":"constructor","field":"timestamp"}]`,
		`[{"variable":"service","label":"service"},{"variable":"service","field":"series"}]`,
		`[{"variable":"value","field":"value"},{"variable":"value","field":"timestamp"}]`,
	} {
		t.Run(bindings, func(t *testing.T) {
			raw := json.RawMessage(`{"type":"query","providerId":"metrics","query":"up","bindings":` + bindings + `}`)
			if _, err := validateTooltipSource(raw); err == nil {
				t.Fatalf("ambiguous or invalid binding accepted: %s", bindings)
			}
		})
	}
}
