package insights

import "testing"

// A time series may carry a baseline: a closed window and an optional band. Other widget types may not.
func TestTimeSeriesBaselineOptionIsClosed(t *testing.T) {
	accepted := map[string]string{
		"previous window":        `"type":"timeseries","options":{"baseline":{"window":"previous"}}`,
		"rolling with p10p90":    `"type":"timeseries","options":{"baseline":{"window":"rolling","band":"p10p90"}}`,
		"seven days, range band": `"type":"timeseries","options":{"baseline":{"window":"7d","band":"range"}}`,
	}
	for name, fields := range accepted {
		t.Run("accepts "+name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(fields, "")); err != nil {
				t.Fatalf("valid baseline rejected: %v", err)
			}
		})
	}
	rejected := map[string]string{
		"on a stat":           `"type":"stat","options":{"baseline":{"window":"1d"}}`,
		"on a bar":            `"type":"bar","options":{"baseline":{"window":"1d"}}`,
		"unknown window":      `"type":"timeseries","options":{"baseline":{"window":"2d"}}`,
		"unknown band":        `"type":"timeseries","options":{"baseline":{"window":"1d","band":"stddev"}}`,
		"missing window":      `"type":"timeseries","options":{"baseline":{"band":"range"}}`,
		"unknown member":      `"type":"timeseries","options":{"baseline":{"window":"1d","colour":"green"}}`,
		"non-object baseline": `"type":"timeseries","options":{"baseline":"1d"}`,
	}
	for name, fields := range rejected {
		t.Run("rejects "+name, func(t *testing.T) {
			if err := validateDashboard("demo", extendedDashboard(fields, "")); err == nil {
				t.Fatal("invalid baseline accepted")
			}
		})
	}
}
