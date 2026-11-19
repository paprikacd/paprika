package insights

import (
	"fmt"
	"strconv"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// guidanceRecordRank is the composition line the record-rank rule maps to.
const guidanceRecordRank = "A record-table rank needs a status source: a status-badge column with a status mapping, or a numeric column whose thresholds name a status."

var pluginLintRules = []lintRule{
	{
		ID:       "plugin.unknown",
		Severity: warningSeverity,
		Summary:  guidanceVariables,
		Fix:      "Set pluginId to a registered plugin, such as stacked-timeseries, threshold-gauge or status-grid.",
		check:    checkUnknownPlugin,
	},
	{
		ID:       "plugin.record-rank",
		Severity: errorSeverity,
		Summary:  guidanceRecordRank,
		Fix:      "Set rank.status to a status-badge column with a status mapping, or to a numeric column whose cellStyles thresholds or widget options.thresholds name a status; order by a different column.",
		check:    checkRecordRank,
	},
}

// numericRankDisplays are the record-table displays whose column is a number, so its thresholds can name a status.
var numericRankDisplays = map[string]bool{"bar": true, "bar-segments": true, "color-text": true, "color-background": true}

// checkRecordRank fires for each record-table whose rank has no status source the UI can draw. The UI rejects
// such a rank when it is edited, but a rank authored through the API saves without that check, so this rule is
// the save-time guard. The pointer names the rank.
func checkRecordRank(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.pluginID != "record-table" || (widget.rank == nil && widget.rankErr == "") {
			continue
		}
		if widget.rank == nil {
			// The rank does not decode, so it names no status column; the decode error is the reason.
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/config/rank",
				widgetID: widget.id,
				message:  fmt.Sprintf("%s has a rank that the editor refuses: %s", widgetLabel(widget), widget.rankErr),
			})
			continue
		}
		if reason := rankSourceProblem(widget); reason != "" {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/config/rank",
				widgetID: widget.id,
				message:  fmt.Sprintf("%s ranks by status column %q, but %s", widgetLabel(widget), widget.rank.Status, reason),
			})
		}
	}
	return hits
}

// rankSourceProblem says why a record-table's rank has no usable status source or option, or returns empty
// when it has both. The schema refuses the same options at Apply; this rule covers a rank saved through the API.
func rankSourceProblem(widget *lintWidget) string {
	rank := widget.rank
	if reason := rankOptionProblem(rank); reason != "" {
		return reason
	}
	var style *wireCellStyle
	for k := range widget.cellStyles {
		if widget.cellStyles[k].Column == rank.Status {
			style = &widget.cellStyles[k]
			break
		}
	}
	return rankStatusSourceProblem(style, widget.statusBands)
}

// rankOptionProblem says why a rank's own members cannot render, or returns empty when they can. It names
// the same limits as the schema: a status and a value that differ, an order, and a limit from 1 to 100.
func rankOptionProblem(rank *wireRank) string {
	switch {
	case rank.Status == "":
		return "it names no status column"
	case rank.Value != "" && rank.Value == rank.Status:
		return "it orders rows by the same column, which must be a different one"
	case rank.Order != "" && rank.Order != "descending" && rank.Order != "ascending":
		return "its order " + strconv.Quote(rank.Order) + " is not descending or ascending"
	case rank.Limit != nil && (*rank.Limit < 1 || *rank.Limit > 100):
		return "its limit must be between 1 and 100"
	}
	return ""
}

// badgeStatusProblem says why a status-badge column's mappings cannot supply a status, or returns empty.
func badgeStatusProblem(mappings []wireMapping) string {
	for _, mapping := range mappings {
		if declaredRankLevel(mapping.Status) != "undeclared" {
			return ""
		}
	}
	return "its status-badge column names no status mapping"
}

// hasDeclaredRankThreshold reports whether a threshold list names one of the five declared statuses.
func hasDeclaredRankThreshold(thresholds []wireThreshold) bool {
	for _, threshold := range thresholds {
		if declaredRankLevel(threshold.Status) != "undeclared" {
			return true
		}
	}
	return false
}

// rankStatusSourceProblem says why a rank's status column cannot supply a status, given the column's own
// style (nil when it has none) and whether the widget's thresholds name a status.
func rankStatusSourceProblem(style *wireCellStyle, statusBands bool) string {
	if style != nil && style.Display == "status-badge" {
		return badgeStatusProblem(style.Mappings)
	}
	if style != nil && !numericRankDisplays[style.Display] {
		return "its column is drawn as " + style.Display + ", which carries no number to rank"
	}
	if style != nil && len(style.Thresholds) > 0 {
		if hasDeclaredRankThreshold(style.Thresholds) {
			return ""
		}
		return "its own thresholds name no status"
	}
	if statusBands {
		return ""
	}
	return "neither its column thresholds nor the widget thresholds name a status"
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
