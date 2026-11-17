package insights

import (
	"fmt"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

var pluginLintRules = []lintRule{
	{
		ID:       "plugin.unknown",
		Severity: warningSeverity,
		Summary:  guidanceVariables,
		Fix:      "Set pluginId to a registered plugin, such as stacked-timeseries, threshold-gauge or status-grid.",
		check:    checkUnknownPlugin,
	},
}

// builtInWidgetPlugins is the set of plugin ids the UI registers by default. It is
// read from the committed list that the UI test regenerates and checks, so it
// cannot drift from the registry. A host may register its own plugins, which the
// rule reports as not built in: a warning, not an error.
var builtInWidgetPlugins = loadBuiltInWidgetPlugins()

func loadBuiltInWidgetPlugins() map[string]bool {
	ids, err := insightsschema.BuiltInWidgetPlugins()
	if err != nil {
		panic(err)
	}
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// checkUnknownPlugin fires for each plugin widget whose pluginId is not a
// registered plugin. The pointer names the pluginId member.
func checkUnknownPlugin(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType != "plugin" || builtInWidgetPlugins[widget.pluginID] {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/pluginId",
			widgetID: widget.id,
			message:  fmt.Sprintf("plugin %q is not a built-in widget plugin", widget.pluginID),
		})
	}
	return hits
}
