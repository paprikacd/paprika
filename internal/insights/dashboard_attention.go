package insights

// dashboardAttentionBasis states what the attention counts, so no reader mistakes it
// for a health verdict.
const dashboardAttentionBasis = "author-declared warning and critical statuses, query failures and staleness only; not a health verdict"

// DashboardAttention is a dashboard-level count of widgets that need attention. Each
// widget is counted once, under its most severe reason: critical, warning, failed or
// stale. Only author-declared statuses count; an undeclared or indeterminate state never
// does. Checked counts widgets whose query returned usable data, so failed, empty and
// partial widgets are unchecked.
type DashboardAttention struct {
	Basis    string `json:"basis"`
	Widgets  int    `json:"widgets"`
	Checked  int    `json:"checked"`
	Critical int    `json:"critical"`
	Warning  int    `json:"warning"`
	Failed   int    `json:"failed"`
	Stale    int    `json:"stale"`
}

// applyDashboardAttention sets each widget's attention reason and returns the rollup.
func applyDashboardAttention(result *DashboardQueryResult) DashboardAttention {
	signals := make(map[string]*DashboardSignal, len(result.Signals))
	for index := range result.Signals {
		signals[result.Signals[index].ID] = &result.Signals[index]
	}
	attention := DashboardAttention{Basis: dashboardAttentionBasis, Widgets: len(result.Widgets)}
	for index := range result.Widgets {
		widget := &result.Widgets[index]
		signal := signals[widget.SignalID]
		failed := widget.Error != nil || (signal != nil && signal.Error != nil)
		if !failed && signal != nil && signal.State == "ok" {
			attention.Checked++
		}
		widget.Attention = dashboardWidgetAttention(widget, failed)
		attention.count(widget.Attention)
	}
	return attention
}

// count adds one widget to the bucket for its attention reason.
func (a *DashboardAttention) count(reason string) {
	switch reason {
	case "critical":
		a.Critical++
	case "warning":
		a.Warning++
	case "failed":
		a.Failed++
	case "stale":
		a.Stale++
	}
}

// dashboardWidgetAttention is the single most severe reason a widget needs attention, or
// empty when none applies. A declared breach in the window outranks a failed read, which
// has no data to breach; staleness is the least severe.
func dashboardWidgetAttention(widget *DashboardQueryWidget, failed bool) string {
	switch {
	case dashboardWidgetDeclares(widget, "critical"):
		return "critical"
	case dashboardWidgetDeclares(widget, "warning"):
		return "warning"
	case failed:
		return "failed"
	case widget.Sample != nil && widget.Sample.State == "stale":
		return "stale"
	}
	return ""
}

// dashboardWidgetDeclares reports whether the author's band at this level currently
// applies to the widget (a matched stat, gauge, status view or heatmap band) or, for a
// time series, whether a breach at this level lies in the returned window.
func dashboardWidgetDeclares(widget *DashboardQueryWidget, level string) bool {
	if widget.Threshold != nil && widget.Threshold.State == "matched" && widget.Threshold.Status == level {
		return true
	}
	if widget.Breaches == nil {
		return false
	}
	for _, entry := range widget.Breaches.Summary {
		if entry.Level == level && (entry.Intervals > 0 || entry.Samples > 0) {
			return true
		}
	}
	return false
}
