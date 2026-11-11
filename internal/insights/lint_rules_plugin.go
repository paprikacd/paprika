package insights

import "fmt"

var pluginLintRules = []lintRule{
	{
		ID:       "plugin.unknown",
		Severity: warningSeverity,
		Summary:  "Name a registered plugin id for every plugin widget.",
		Fix:      "Set pluginId to a registered plugin, such as stacked-timeseries, threshold-gauge or status-grid.",
		check:    checkUnknownPlugin,
	},
}

// registeredWidgetPlugins lists the plugin ids the Insights UI registers, from
// the registerWidgetPlugin calls and their entry arrays under ui/src/features/insights.
// The schema accepts any well-formed id, so this list is what makes a misspelled
// plugin visible. TestRegisteredWidgetPluginsMatchTheUI checks that each id is still
// registered in the UI source; a plugin added to the UI must be added here too.
var registeredWidgetPlugins = map[string]bool{
	"connection-map": true, "directional-traffic": true, "distribution-heatmap": true, "geo-heatmap": true,
	"incident-calendar": true, "pie": true, "pipeline-topology": true, "record-list": true,
	"record-matrix": true, "record-table": true, "record-treemap": true, "records-bar": true,
	"records-line": true, "small-multiples": true, "stacked-timeseries": true, "status-grid": true,
	"status-history": true, "threshold-gauge": true, "uptime-calendar": true, "uptime-timeline": true,
}

// checkUnknownPlugin fires for each plugin widget whose pluginId is not a
// registered plugin. The pointer names the pluginId member.
func checkUnknownPlugin(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType != "plugin" || registeredWidgetPlugins[widget.pluginID] {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/pluginId",
			widgetID: widget.id,
			message:  fmt.Sprintf("plugin %q is not a registered plugin", widget.pluginID),
		})
	}
	return hits
}
