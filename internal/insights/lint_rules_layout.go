package insights

import "fmt"

// guidanceLayout is the guidance line the layout rules map to.
const guidanceLayout = "Place widgets without overlaps and fill each row; a gap beside a widget is not closed automatically."

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
		Fix:      "Resize the widgets beside the gap, or rearrange the row, so the cells above this widget are filled. Moving this widget up would overlap the widget above it.",
		check:    checkLayoutHoles,
	},
}

// overlapKey names a pair of widgets by their ids, in either order.
type overlapKey [2]string

func overlapKeyOf(a, b string) overlapKey {
	if b < a {
		a, b = b, a
	}
	return overlapKey{a, b}
}

// overlapPair is a pair of widgets whose grid rectangles share at least one cell.
type overlapPair struct {
	key            overlapKey
	earlier, later *lintWidget
}

// overlapPairs lists the overlapping pairs in document order of the later widget,
// then of the earlier one. Touching edges do not overlap.
func overlapPairs(doc *lintDocument) []overlapPair {
	var pairs []overlapPair
	for j := range doc.widgets {
		later := &doc.widgets[j]
		for i := range j {
			earlier := &doc.widgets[i]
			if earlier.x < later.x+later.w && later.x < earlier.x+earlier.w && earlier.y < later.y+later.h && later.y < earlier.y+earlier.h {
				pairs = append(pairs, overlapPair{key: overlapKeyOf(earlier.id, later.id), earlier: earlier, later: later})
			}
		}
	}
	return pairs
}

// checkLayoutOverlap fires once for each pair of widgets whose grid rectangles
// share at least one cell. The pointer names the later widget's layout, and the
// message names both ids.
func checkLayoutOverlap(doc *lintDocument) []lintHit {
	pairs := overlapPairs(doc)
	hits := make([]lintHit, 0, len(pairs))
	for _, pair := range pairs {
		hits = append(hits, lintHit{
			pointer:  widgetBase(pair.later.index) + "/layout",
			widgetID: pair.later.id,
			message:  widgetLabel(pair.later) + " overlaps " + widgetLabel(pair.earlier),
			pair:     pair.key,
		})
	}
	return hits
}

// checkLayoutHoles fires for each widget that has empty grid cells above it on the
// layout the canvas draws (see compactBoxes). A cell is empty when no widget covers
// it and some widget lies below it in the same column. A stored gap that the
// canvas closes is not a hole, so it is not reported. Each widget is reported once,
// with the count of cells above it. The pointer names its layout y. Fixing a hole
// means resizing a neighbour or rearranging the row: moving the widget up would
// overlap, which is why the fix text says so.
func checkLayoutHoles(doc *lintDocument) []lintHit {
	if len(doc.widgets) == 0 {
		return nil
	}
	// Holes are measured on the drawn layout, which pushes overlapping widgets apart
	// and leaves cells above the pushed ones. Those cells are an effect of the
	// overlap, which is the finding to fix, so a document with an overlap reports
	// no holes.
	if len(checkLayoutOverlap(doc)) > 0 {
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
