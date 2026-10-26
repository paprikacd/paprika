package insights

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func extendedDashboard(widgetFields, dashboardFields string) Dashboard {
	document := string(dashboard("demo", "Demo"))
	if widgetFields != "" {
		document = strings.Replace(document, `"type":"timeseries"`, widgetFields, 1)
	}
	if dashboardFields != "" {
		document = strings.Replace(document, `"schemaVersion":1`, `"schemaVersion":1,`+dashboardFields, 1)
	}
	return []byte(document)
}

func TestRichDashboardRoundTrip(t *testing.T) {
	s, _ := testService(t)
	for _, document := range []Dashboard{
		extendedDashboard(`"type":"heatmap","options":{"display":"area","xAxisLabel":"Time","yAxisLabel":"Latency","showLegend":false,"showTooltip":true,"showGrid":true,"decimals":3,"min":0,"max":100,"lineWidth":1.5,"fillOpacity":0.3,"curve":"step","background":"#101010","textColor":"#eeeeee","thresholds":[{"value":50,"color":"#ffcc00","label":"Warning"},{"value":90,"color":"#ff0000","label":"Critical"}]}`, `"folder":"Payments/Production","customTimeRange":{"from":"2026-10-01T00:00:00+10:00","to":"2026-10-02T00:00:00+10:00"}`),
		extendedDashboard(`"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":{"target":99,"flags":[true,false],"nested":{"unit":"percent"}},"options":{"min":0,"max":100}`, `"folder":"Team/Service"`),
	} {
		w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
		if w.Code != 200 {
			t.Fatalf("valid extended document rejected: %d %s", w.Code, w.Body)
		}
		w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
		var expected, actual any
		_ = json.Unmarshal(document, &expected)
		_ = json.Unmarshal(w.Body.Bytes(), &actual)
		a, _ := json.Marshal(actual)
		e, _ := json.Marshal(expected)
		if string(a) != string(e) {
			t.Fatalf("extension data lost on roundtrip: %s", w.Body)
		}
	}
}

func TestRichDashboardRejectsUnsafeOrUnrenderableOptions(t *testing.T) {
	for name, fields := range map[string]string{
		"unknown option":             `"type":"timeseries","options":{"script":"evil"}`,
		"null options":               `"type":"timeseries","options":null`,
		"axis type":                  `"type":"timeseries","options":{"xAxisLabel":3}`,
		"long axis":                  `"type":"timeseries","options":{"xAxisLabel":"` + strings.Repeat("x", 81) + `"}`,
		"boolean type":               `"type":"timeseries","options":{"showGrid":"true"}`,
		"decimals fraction":          `"type":"timeseries","options":{"decimals":1.5}`,
		"decimals limit":             `"type":"timeseries","options":{"decimals":9}`,
		"axis bounds":                `"type":"timeseries","options":{"min":100,"max":20}`,
		"line width":                 `"type":"timeseries","options":{"lineWidth":0}`,
		"opacity":                    `"type":"timeseries","options":{"fillOpacity":2}`,
		"curve":                      `"type":"timeseries","options":{"curve":"javascript"}`,
		"invalid color":              `"type":"timeseries","options":{"background":"url(http://evil)"}`,
		"infinite bound":             `"type":"timeseries","options":{"min":1e400}`,
		"unsorted thresholds":        `"type":"timeseries","options":{"thresholds":[{"value":20,"color":"#ff0000"},{"value":10,"color":"#ffcc00"}]}`,
		"duplicate threshold":        `"type":"timeseries","options":{"thresholds":[{"value":10,"color":"#ff0000"},{"value":10,"color":"#ffcc00"}]}`,
		"null threshold":             `"type":"timeseries","options":{"thresholds":[null]}`,
		"unknown threshold field":    `"type":"timeseries","options":{"thresholds":[{"value":10,"color":"#ff0000","unexpected":true}]}`,
		"plugin metadata on builtin": `"type":"timeseries","pluginId":"gauge"`,
		"plugin missing identity":    `"type":"plugin","dataKind":"metrics"`,
		"plugin missing data kind":   `"type":"plugin","pluginId":"gauge"`,
		"plugin invalid data kind":   `"type":"plugin","pluginId":"gauge","dataKind":"logs"`,
		"plugin array config":        `"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":[]`,
		"plugin prototype pollution": `"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":{"nested":{"__proto__":{"evil":true}}}`,
		"plugin constructor":         `"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":{"constructor":{}}`,
		"plugin excessive depth":     `"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":1}}}}}}}}}`,
		"plugin excessive size":      `"type":"plugin","pluginId":"gauge","dataKind":"metrics","config":{"value":"` + strings.Repeat("x", 16384) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(fields, "")); err == nil {
				t.Fatal("unsafe extension accepted")
			}
		})
	}
}

func TestDashboardFolderAndCustomRangeValidation(t *testing.T) {
	for name, fields := range map[string]string{
		"empty folder":         `"folder":""`,
		"parent folder":        `"folder":"Team/../Secrets"`,
		"empty folder segment": `"folder":"Team//Prod"`,
		"untrimmed segment":    `"folder":"Team/ Prod"`,
		"leading slash":        `"folder":"/Team"`,
		"backslash":            `"folder":"Team\\Prod"`,
		"control character":    `"folder":"Team\nProd"`,
		"oversized folder":     `"folder":"` + strings.Repeat("x", 161) + `"`,
		"range missing zone":   `"customTimeRange":{"from":"2026-10-01T00:00:00","to":"2026-10-02T00:00:00"}`,
		"range invalid date":   `"customTimeRange":{"from":"2026-02-30T00:00:00Z","to":"2026-03-02T00:00:00Z"}`,
		"range reversed":       `"customTimeRange":{"from":"2026-10-02T00:00:00Z","to":"2026-10-01T00:00:00Z"}`,
		"range too large":      `"customTimeRange":{"from":"2026-08-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`,
		"range epoch":          `"customTimeRange":{"from":"1970-01-01T00:00:00Z","to":"1970-01-02T00:00:00Z"}`,
		"range submillisecond": `"customTimeRange":{"from":"2026-10-01T00:00:00.0001Z","to":"2026-10-01T00:00:00.0002Z"}`,
		"unknown range field":  `"customTimeRange":{"from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z","extra":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard("", fields)); err == nil {
				t.Fatal("invalid folder/range accepted")
			}
		})
	}
}

func TestHeatmapVisibilityOptionsRoundTrip(t *testing.T) {
	s, _ := testService(t)
	for _, showLabels := range []bool{true, false} {
		for _, showValues := range []bool{true, false} {
			t.Run(fmt.Sprintf("labels=%t/values=%t", showLabels, showValues), func(t *testing.T) {
				document := extendedDashboard(fmt.Sprintf(`"type":"heatmap","options":{"showLabels":%t,"showValues":%t}`, showLabels, showValues), "")
				saved := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
				if saved.Code != 200 {
					t.Fatalf("visibility options rejected: %d %s", saved.Code, saved.Body)
				}
				loaded := request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
				var decoded struct {
					Widgets []struct {
						Options map[string]bool `json:"options"`
					} `json:"widgets"`
				}
				if err := json.Unmarshal(loaded.Body.Bytes(), &decoded); err != nil {
					t.Fatal(err)
				}
				labels, labelsPresent := decoded.Widgets[0].Options["showLabels"]
				values, valuesPresent := decoded.Widgets[0].Options["showValues"]
				if !labelsPresent || !valuesPresent || labels != showLabels || values != showValues {
					t.Fatalf("visibility settings changed after persistence: %s", loaded.Body)
				}
			})
		}
	}
}

func TestHeatmapVisibilityRequiresBooleans(t *testing.T) {
	for _, field := range []string{"showLabels", "showValues"} {
		for _, invalid := range []string{`null`, `"false"`, `0`, `[]`, `{}`} {
			t.Run(field+"="+invalid, func(t *testing.T) {
				document := extendedDashboard(fmt.Sprintf(`"type":"heatmap","options":{"%s":%s}`, field, invalid), "")
				if err := validateDashboard("demo", document); err == nil {
					t.Fatal("non-boolean visibility setting accepted")
				}
			})
		}
	}
	if err := validateDashboard("demo", extendedDashboard(`"type":"heatmap","options":{}`, "")); err != nil {
		t.Fatalf("legacy heatmap with omitted visibility rejected: %v", err)
	}
}
