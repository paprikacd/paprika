package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

// The time-series rendering options share the UI schema's keys, ranges and defaults.
func TestTimeSeriesRenderingOptionsRoundTrip(t *testing.T) {
	s, _ := testService(t)
	document := extendedDashboard(`"type":"timeseries","options":{"gridX":true,"timeAxis":"calendar","axisUnit":"caption","referenceLines":[{"value":5,"label":"Target","color":"#c08a2b"},{"value":-1}],"showZeroLine":true,"plotInsetLeft":60,"plotInsetRight":12}`, "")
	if err := validateDashboard("demo", document); err != nil {
		t.Fatalf("valid rendering options rejected: %v", err)
	}
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if w.Code != 200 {
		t.Fatalf("valid rendering options rejected by the service: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
	var expected, actual any
	_ = json.Unmarshal(document, &expected)
	_ = json.Unmarshal(w.Body.Bytes(), &actual)
	a, _ := json.Marshal(actual)
	e, _ := json.Marshal(expected)
	if string(a) != string(e) {
		t.Fatalf("rendering options lost on roundtrip: %s", w.Body)
	}
}

func TestTimeSeriesRenderingOptionsBoundaries(t *testing.T) {
	eight := make([]string, 0, 8)
	for range 8 {
		eight = append(eight, `{"value":1}`)
	}
	nine := make([]string, 0, 9)
	for range 9 {
		nine = append(nine, `{"value":1}`)
	}
	for name, options := range map[string]string{
		"reference lines at the limit":  `"referenceLines":[` + strings.Join(eight, ",") + `]`,
		"reference label at the limit":  `"referenceLines":[{"value":1,"label":"` + strings.Repeat("x", 80) + `"}]`,
		"inset left at the minimum":     `"plotInsetLeft":8`,
		"inset left at the maximum":     `"plotInsetLeft":240`,
		"inset right at the maximum":    `"plotInsetRight":120`,
		"zero line and gridlines false": `"showZeroLine":false,"gridX":false`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(`"type":"timeseries","options":{`+options+`}`, "")); err != nil {
				t.Fatalf("valid option rejected: %v", err)
			}
		})
	}
	for name, options := range map[string]string{
		"nine reference lines":          `"referenceLines":[` + strings.Join(nine, ",") + `]`,
		"null reference lines":          `"referenceLines":null`,
		"reference value missing":       `"referenceLines":[{"label":"Target"}]`,
		"reference value a string":      `"referenceLines":[{"value":"5"}]`,
		"reference value null":          `"referenceLines":[{"value":null}]`,
		"reference label empty":         `"referenceLines":[{"value":1,"label":""}]`,
		"reference label null":          `"referenceLines":[{"value":1,"label":null}]`,
		"reference label too long":      `"referenceLines":[{"value":1,"label":"` + strings.Repeat("x", 81) + `"}]`,
		"reference color not hex":       `"referenceLines":[{"value":1,"color":"red"}]`,
		"reference color null":          `"referenceLines":[{"value":1,"color":null}]`,
		"reference unknown key":         `"referenceLines":[{"value":1,"style":"dashed"}]`,
		"reference entry not an object": `"referenceLines":[5]`,
		"time axis unknown":             `"timeAxis":"monthly"`,
		"time axis null":                `"timeAxis":null`,
		"axis unit unknown":             `"axisUnit":"inline"`,
		"grid flag not boolean":         `"gridX":"yes"`,
		"zero line flag numeric":        `"showZeroLine":1`,
		"inset left below minimum":      `"plotInsetLeft":7`,
		"inset left above maximum":      `"plotInsetLeft":241`,
		"inset right above maximum":     `"plotInsetRight":121`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(`"type":"timeseries","options":{`+options+`}`, "")); err == nil {
				t.Fatalf("invalid rendering option accepted: %s", options)
			}
		})
	}
}
