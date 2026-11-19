package insights

import (
	"fmt"
	"strconv"
)

// guidanceSharedThresholds is the composition line the table rule maps to.
const guidanceSharedThresholds = "Columns that share one set of value thresholds must use one unit and bar range; give a column on a different scale its own thresholds."

var tableLintRules = []lintRule{
	{
		ID:       "table.shared-thresholds",
		Severity: warningSeverity,
		Summary:  guidanceSharedThresholds,
		Fix:      "Give the column on a different scale its own thresholds under its cellStyles entry, or give the shared columns one unit and, for bars, one min and max.",
		check:    checkSharedThresholds,
	},
}

// thresholdColourDisplays are the record-table displays that colour a value from the widget's bands.
var thresholdColourDisplays = map[string]bool{"bar": true, "bar-segments": true, "color-text": true, "color-background": true}

// cellScale is the authored scale of a record-table column: its unit and, for a bar, its bounds. A
// colour-only column has no authored bounds, so only its unit can be compared.
type cellScale struct {
	unit     string
	bar      bool
	min, max float64
}

func scaleOf(style *wireCellStyle) cellScale {
	scale := cellScale{unit: style.Unit}
	if style.Display == "bar" || style.Display == "bar-segments" {
		scale.bar = true
		if style.Min != nil {
			scale.min = *style.Min
		}
		if style.Max != nil {
			scale.max = *style.Max
		}
	}
	return scale
}

// differs reports whether two columns read on different scales. Units are compared only when both columns
// author one: the renderer falls back to the result column's unit when a style omits it, and the lint cannot
// see that unit, so an omitted unit is never reported as a difference. Two bars differ when their bounds
// differ. A colour-only column is not compared on bounds, so it can share a bar's unit.
func (s cellScale) differs(other cellScale) bool {
	unitDiffers := s.unit != "" && other.unit != "" && s.unit != other.unit
	return unitDiffers || (s.bar && other.bar && (s.min != other.min || s.max != other.max))
}

// text names the authored scale for a message: the authored unit, or none, and a bar's bounds.
func (s cellScale) text() string {
	unit := "no authored unit"
	if s.unit != "" {
		unit = "unit " + strconv.Quote(s.unit)
	}
	if s.bar {
		return fmt.Sprintf("%s, bar range %s to %s", unit, strconv.FormatFloat(s.min, 'f', -1, 64), strconv.FormatFloat(s.max, 'f', -1, 64))
	}
	return unit
}

// checkSharedThresholds fires once per record-table widget whose colour columns, lacking their own
// thresholds, share the widget's Value thresholds while their authored scales differ. The pointer names
// the first such column whose scale differs from the first shared column. Only authored units and bar
// bounds are compared: a column that omits its unit is not compared on units, because the renderer takes
// the unit from the result column, and the lint cannot see the data, so a column whose values sit outside
// its bounds is not detected. A colour-only column has no authored range, so it is never compared on bounds: a
// colour-only percentage beside a 0-100 bar on the same unit is not flagged, and the author gives it its own
// thresholds instead (the gallery's availability column does).
func checkSharedThresholds(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.pluginID != "record-table" || widget.thresholds == 0 {
			continue
		}
		var first *cellScale
		var firstColumn string
		for k := range widget.cellStyles {
			style := &widget.cellStyles[k]
			if !thresholdColourDisplays[style.Display] || len(style.Thresholds) > 0 {
				continue
			}
			scale := scaleOf(style)
			if first == nil {
				first, firstColumn = &scale, style.Column
				continue
			}
			if first.differs(scale) {
				hits = append(hits, lintHit{
					pointer:  widgetBase(widget.index) + "/config/cellStyles/" + strconv.Itoa(k),
					widgetID: widget.id,
					message: fmt.Sprintf("%s shares its Value thresholds between column %q (%s) and column %q (%s); give one its own thresholds or align the units and bar ranges",
						widgetLabel(widget), firstColumn, first.text(), style.Column, scale.text()),
				})
				break
			}
		}
	}
	return hits
}
