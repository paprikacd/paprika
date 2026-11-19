package insights

import "testing"

// A stat may compare its value with an earlier window; no other widget may, and the window and direction are closed sets.
func TestStatCompareOptionIsStatOnlyAndClosed(t *testing.T) {
	accepted := map[string]string{
		"previous, no direction":  `"type":"stat","options":{"compare":{"window":"previous"}}`,
		"one day, higher is up":   `"type":"stat","options":{"compare":{"window":"1d","good":"up"}}`,
		"seven days, higher down": `"type":"stat","options":{"compare":{"window":"7d","good":"down"}}`,
	}
	for name, fields := range accepted {
		t.Run("accepts "+name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(fields, "")); err != nil {
				t.Fatalf("valid comparison rejected: %v", err)
			}
		})
	}
	rejected := map[string]string{
		"on a time series":      `"type":"timeseries","options":{"compare":{"window":"previous"}}`,
		"on a bar":              `"type":"bar","options":{"compare":{"window":"1d"}}`,
		"unknown window":        `"type":"stat","options":{"compare":{"window":"2d"}}`,
		"unknown direction":     `"type":"stat","options":{"compare":{"window":"previous","good":"none"}}`,
		"unknown member":        `"type":"stat","options":{"compare":{"window":"previous","colour":"green"}}`,
		"missing window":        `"type":"stat","options":{"compare":{"good":"up"}}`,
		"non-object comparison": `"type":"stat","options":{"compare":"previous"}`,
	}
	for name, fields := range rejected {
		t.Run("rejects "+name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(fields, "")); err == nil {
				t.Fatal("invalid comparison accepted")
			}
		})
	}
}
