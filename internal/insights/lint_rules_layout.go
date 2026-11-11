package insights

import (
	"fmt"
	"strconv"
)

// maxGridRows bounds the rows a layout can occupy: y is at most 1000 and h at
// most 12 under the schema, so every covered row is below this index.
const maxGridRows = 1013

// guidanceLayout is the guidance line the layout rules map to.
const guidanceLayout = "Place widgets without overlaps and fill each row; a gap beside a widget stays empty."

var layoutLintRules = []lintRule{
	{
		ID:       "layout.overlap",
		Severity: errorSeverity,
		Summary:  guidanceLayout,
		Fix:      "Move or resize one of the two widgets so their grid rectangles do not intersect.",
		check:    checkLayoutOverlap,
	},
	{
		ID:       "layout.hole",
		Severity: warningSeverity,
		Summary:  guidanceLayout,
		Fix:      "Move the widgets below the gap up so that every grid row between the top and bottom widgets holds a widget.",
		check:    checkLayoutHoles,
	},
}

// checkLayoutOverlap fires once for each pair of widgets whose grid rectangles
// share at least one cell. The pointer names the later widget's layout, and the
// message names both ids. Touching edges do not overlap.
func checkLayoutOverlap(doc *lintDocument) []lintHit {
	var hits []lintHit
	for j := range doc.widgets {
		later := &doc.widgets[j]
		for i := range j {
			earlier := &doc.widgets[i]
			if earlier.x < later.x+later.w && later.x < earlier.x+earlier.w && earlier.y < later.y+later.h && later.y < earlier.y+earlier.h {
				hits = append(hits, lintHit{
					pointer:  widgetBase(later.index) + "/layout",
					widgetID: later.id,
					message:  widgetLabel(later) + " overlaps " + widgetLabel(earlier),
				})
			}
		}
	}
	return hits
}

// checkLayoutHoles fires once for each run of grid rows that lies between the
// top and bottom of the dashboard and holds no widget. A gap above the first
// widget is not checked, since the layout is only measured between its widgets.
// The pointer names the widget whose top edge closes the gap.
func checkLayoutHoles(doc *lintDocument) []lintHit {
	if len(doc.widgets) == 0 {
		return nil
	}
	var covered [maxGridRows]bool
	top, bottom := maxGridRows, 0
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		top = min(top, widget.y)
		bottom = max(bottom, widget.y+widget.h)
		for row := max(widget.y, 0); row < min(widget.y+widget.h, maxGridRows); row++ {
			covered[row] = true
		}
	}
	var hits []lintHit
	for row := top; row < bottom; {
		if covered[row] {
			row++
			continue
		}
		start := row
		for row < bottom && !covered[row] {
			row++
		}
		closing := closingWidget(doc, row)
		hits = append(hits, lintHit{
			pointer:  closing.pointer,
			widgetID: closing.widgetID,
			message:  fmt.Sprintf("grid rows %s to %s hold no widget between the widgets above and below", strconv.Itoa(start), strconv.Itoa(row-1)),
		})
	}
	return hits
}

// closingWidget finds the first widget whose top edge is at row. It is the
// widget that closes a gap, and its layout y is the pointer a fix edits.
func closingWidget(doc *lintDocument, row int) lintHit {
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.y == row {
			return lintHit{pointer: widgetBase(widget.index) + "/layout/y", widgetID: widget.id}
		}
	}
	return lintHit{}
}
