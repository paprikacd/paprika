package insights

import (
	"testing"
)

// The dashboard-level event source is planned once, and only when a selected time-based widget inherits it.
func TestDashboardSourceAnnotationPlansOnlyForInheritingWidgets(t *testing.T) {
	source := &dashboardReadAnnotation{QueryRef: dashboardReadReference{ID: "events"}, TimestampColumn: "date", LabelColumn: "label"}
	timeseries := dashboardReadWidget{ID: "rate", Type: "timeseries"}
	optedOut := dashboardReadWidget{ID: "quiet", Type: "timeseries"}
	hide := false
	optedOut.Options.ShowEvents = &hide
	ownSource := dashboardReadWidget{ID: "own", Type: "timeseries", AnnotationSource: source}
	bar := dashboardReadWidget{ID: "bar", Type: "bar"}
	cases := map[string]struct {
		selected []dashboardReadWidget
		planned  []string
	}{
		"an inheriting time series":     {[]dashboardReadWidget{timeseries}, []string{"rate"}},
		"only the widgets that inherit": {[]dashboardReadWidget{timeseries, optedOut, ownSource, bar}, []string{"rate"}},
		"no inheriting widget at all":   {[]dashboardReadWidget{optedOut, ownSource, bar}, nil},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{}}
			var queries []Query
			planDashboardSourceAnnotation(result, source, tc.selected, map[string]dashboardSavedSnapshot{}, map[string]bool{}, map[Query]string{}, &queries, nil, 1000, 4600, func(string) float64 { return 0 }, nil)
			if len(tc.planned) == 0 {
				if result.Annotations != nil || len(queries) != 0 {
					t.Fatalf("nothing inherits, so nothing is planned: annotations=%+v queries=%d", result.Annotations, len(queries))
				}
				return
			}
			// No saved query is stored in this unit, so the event query itself fails to resolve. The plan still names the
			// source and the widgets that inherit it, which is what the gating decides.
			if result.Annotations == nil || result.Annotations.SavedQueryID != "events" {
				t.Fatalf("annotations: %+v", result.Annotations)
			}
			if len(result.Annotations.WidgetIDs) != len(tc.planned) || result.Annotations.WidgetIDs[0] != tc.planned[0] {
				t.Fatalf("inheriting widgets: %v", result.Annotations.WidgetIDs)
			}
		})
	}
}

func TestDashboardSourceAnnotationNeverPlansAShowEventsFalseWidget(t *testing.T) {
	hide := false
	widget := dashboardReadWidget{Type: "timeseries"}
	widget.Options.ShowEvents = &hide
	if inheritsDashboardEvents(&widget) {
		t.Fatal("a widget that opts out does not inherit the dashboard's events")
	}
	if !inheritsDashboardEvents(&dashboardReadWidget{Type: "stat"}) {
		t.Fatal("an unset showEvents inherits the dashboard's events")
	}
}
