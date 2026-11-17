package insights

import "slices"

// canvasColumns is the desktop canvas's column count, the grid saved layouts are
// authored on.
const canvasColumns = 12

// gridBox is one widget's position on the canvas grid.
type gridBox struct{ x, y, w, h int }

// compactItem is a widget in the compaction: its input index and its box, which
// the compaction moves in place.
type compactItem struct {
	index int
	box   gridBox
}

// compactBoxes is a port of react-grid-layout's vertical compactor (2.3.0, the
// version the canvas uses) on canvasColumns. It returns each box in input order,
// with the position the canvas draws for it. Items are sorted by row and column.
// An item rises as far as it can. An item that collides with one already placed
// is pushed below it, and the items below it are pushed in turn. The port follows
// the algorithm step for step, including the in-place push of items that are not
// yet placed. The parity fixtures in docs/design/insights/conformance keep the two
// implementations equal.
func compactBoxes(input []gridBox) []gridBox {
	items := make([]*compactItem, len(input))
	for i, box := range input {
		items[i] = &compactItem{index: i, box: box}
	}
	sorted := slices.Clone(items)
	slices.SortStableFunc(sorted, func(a, b *compactItem) int {
		if a.box.y != b.box.y {
			return a.box.y - b.box.y
		}
		return a.box.x - b.box.x
	})
	placed := make([]gridBox, 0, len(input))
	maxY := 0
	out := make([]gridBox, len(input))
	for _, sortedItem := range sorted {
		box := sortedItem.box
		compactItemVertical(placed, &box, sorted, sortedItem.index, maxY)
		placed = append(placed, box)
		maxY = max(maxY, box.y+box.h)
		out[sortedItem.index] = box
	}
	return out
}

// compactItemVertical settles one box: it clamps the box into the grid, rises to
// the first free row, then resolves each collision by pushing the box down. maxY
// is the bottom of everything placed so far, so the box never starts below it.
func compactItemVertical(placed []gridBox, box *gridBox, layout []*compactItem, index, maxY int) {
	box.x = max(box.x, 0)
	box.y = max(box.y, 0)
	box.y = min(maxY, box.y)
	for box.y > 0 && !collidesWithAny(placed, *box) {
		box.y--
	}
	for {
		collision, ok := firstCollision(placed, *box)
		if !ok {
			break
		}
		resolveCompactionCollision(layout, index, box, collision.y+collision.h)
	}
	box.y = max(box.y, 0)
}

// resolveCompactionCollision moves box down to moveTo, pushing each item below it
// that it collides with. It mirrors react-grid-layout's resolveCompactionCollision
// on the y axis. The pushed items are the layout's own items, so their boxes
// change in place, as they do in the reference.
func resolveCompactionCollision(layout []*compactItem, index int, box *gridBox, moveTo int) {
	box.y++
	position := slices.IndexFunc(layout, func(item *compactItem) bool { return item.index == index })
	for i := position + 1; i < len(layout); i++ {
		other := layout[i]
		if other.box.y > box.y+box.h {
			break
		}
		if boxesCollide(*box, other.box) {
			resolveCompactionCollision(layout, other.index, &other.box, moveTo+box.h)
		}
	}
	box.y = moveTo
}

// firstCollision returns the first placed box that overlaps box.
func firstCollision(placed []gridBox, box gridBox) (gridBox, bool) {
	for _, other := range placed {
		if boxesCollide(other, box) {
			return other, true
		}
	}
	return gridBox{}, false
}

func collidesWithAny(placed []gridBox, box gridBox) bool {
	_, ok := firstCollision(placed, box)
	return ok
}

// boxesCollide reports whether two boxes share at least one cell. Touching edges do not collide.
func boxesCollide(a, b gridBox) bool {
	if a.x+a.w <= b.x || a.x >= b.x+b.w || a.y+a.h <= b.y || a.y >= b.y+b.h {
		return false
	}
	return true
}
