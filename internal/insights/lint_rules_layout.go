package insights

import "fmt"

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

// checkLayoutHoles fires for each widget that has empty grid cells above it on the
// layout the canvas draws (see compactBoxes). A cell is empty when no widget covers
// it and some widget lies below it in the same column. Such a cell is a gap the
// viewer sees, and a widget can rise into it. A stored gap that the canvas would
// close is not a hole, so it is not reported. Each widget is reported once, with
// the count of cells above it. The pointer names its layout y, the member an
// author moves.
func checkLayoutHoles(doc *lintDocument) []lintHit {
	if len(doc.widgets) == 0 {
		return nil
	}
	boxes := make([]gridBox, len(doc.widgets))
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		boxes[i] = gridBox{x: widget.x, y: widget.y, w: widget.w, h: widget.h}
	}
	holes := cellsAboveEachBox(compactBoxes(boxes))
	var hits []lintHit
	for k := range doc.widgets {
		if holes[k] == 0 {
			continue
		}
		widget := &doc.widgets[k]
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/layout/y",
			widgetID: widget.id,
			message:  emptyCellsMessage(holes[k]) + " above " + widgetLabel(widget),
		})
	}
	return hits
}

// cellsAboveEachBox counts, for each box in a drawn layout, the empty cells that
// sit above it. A cell is attributed to the nearest covered cell below it in its
// column, so each hole belongs to the box it is above.
func cellsAboveEachBox(drawn []gridBox) []int {
	bottom := 0
	for _, box := range drawn {
		bottom = max(bottom, box.y+box.h)
	}
	// owner holds one plus the index of the box covering each cell; zero is empty.
	owner := make([]int, bottom*canvasColumns)
	for k, box := range drawn {
		for row := box.y; row < box.y+box.h; row++ {
			for column := box.x; column < box.x+box.w; column++ {
				owner[row*canvasColumns+column] = k + 1
			}
		}
	}
	holes := make([]int, len(drawn))
	for column := range canvasColumns {
		// Scanning up a column, the last covered cell seen is the nearest one below.
		below := 0
		for row := bottom - 1; row >= 0; row-- {
			if covering := owner[row*canvasColumns+column]; covering != 0 {
				below = covering
			} else if below != 0 {
				holes[below-1]++
			}
		}
	}
	return holes
}

func emptyCellsMessage(count int) string {
	if count == 1 {
		return "1 empty grid cell sits"
	}
	return fmt.Sprintf("%d empty grid cells sit", count)
}
