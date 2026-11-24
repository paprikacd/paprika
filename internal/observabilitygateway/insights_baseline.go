package observabilitygateway

import (
	"fmt"
	"strconv"
	"strings"
)

// dashboardTextBaseline is a time series' band, as the text synopsis reads it. Fraction is the share of evaluated
// samples beyond the band, and Reason says why no sample had a band.
type dashboardTextBaseline struct {
	State         string   `json:"state"`
	Window        string   `json:"window"`
	OffsetSeconds *float64 `json:"offsetSeconds"`
	Evaluated     int      `json:"evaluated"`
	Outside       int      `json:"outside"`
	Fraction      *float64 `json:"fraction"`
	Reason        string   `json:"reason"`
}

// baselineWindowText names the band's earlier period as a reader would: the offset for a previous period, or the
// lagged recent samples for a rolling band.
func baselineWindowText(band *dashboardTextBaseline) string {
	if band.Window == "rolling" {
		return "rolling"
	}
	if band.OffsetSeconds == nil {
		return "earlier"
	}
	return comparisonDurationPhrase(*band.OffsetSeconds) + " earlier"
}

// appendDashboardBaselineText states each time series' band: how many evaluated samples lie outside it. The words describe
// the chart's own history. They are not an alert, and a state other than ok or partial says why there is no band.
func appendDashboardBaselineText(out *strings.Builder, widgets []dashboardTextWidget) {
	for index := range widgets {
		widget := &widgets[index]
		if widget.Baseline == nil {
			continue
		}
		band := widget.Baseline
		var line strings.Builder
		fmt.Fprintf(&line, "widget %s: baseline %s: state=%s", strconv.Quote(shortDashboardText(widget.ID, 80)), baselineWindowText(band), strconv.Quote(shortDashboardText(band.State, 24)))
		if band.Fraction != nil {
			fmt.Fprintf(&line, " outside the %s range in %.0f%% of samples", baselineWindowText(band), *band.Fraction*100)
		}
		fmt.Fprintf(&line, " evaluated=%d outside=%d", band.Evaluated, band.Outside)
		if band.Reason != "" {
			fmt.Fprintf(&line, " reason=%s", strconv.Quote(shortDashboardText(band.Reason, 48)))
		}
		line.WriteByte('\n')
		if out.Len()+line.Len()+128 > dashboardQueryTextBytes {
			return
		}
		out.WriteString(line.String())
	}
}
