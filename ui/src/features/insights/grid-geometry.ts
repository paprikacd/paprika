/**
 * The canvas grid's pixel geometry. The wide grid (react-grid-layout) and the pixel footprints that
 * the layout, focus and preview code compute both read these values, so they cannot drift apart.
 *
 * Standard viewing uses the roomy grid. Dense viewing (wide canvas, not editing) uses the finer grid.
 */

/** Columns in the wide grid. */
export const GRID_COLUMNS = 12

export interface GridGeometry {
  /** Height of one row unit, in pixels. */
  rowHeight: number
  /** Horizontal gap between columns, in pixels. */
  gapX: number
  /** Vertical gap between rows, in pixels. */
  gapY: number
}

export const STANDARD_GRID: GridGeometry = { rowHeight: 58, gapX: 16, gapY: 16 }
export const DENSE_GRID: GridGeometry = { rowHeight: 25, gapX: 8, gapY: 4 }

/** The geometry for the standard or dense projection. */
export function gridOf(dense: boolean): GridGeometry {
  return dense ? DENSE_GRID : STANDARD_GRID
}

/** The pixel height of `rows` row units, without the trailing gap. */
export function rowsToPixels(rows: number, dense = false): number {
  const grid = gridOf(dense)
  return rows * (grid.rowHeight + grid.gapY) - grid.gapY
}

/** The fewest row units whose pixel height reaches `pixels`. */
export function pixelsToRows(pixels: number, dense = false): number {
  const grid = gridOf(dense)
  return Math.ceil((pixels + grid.gapY) / (grid.rowHeight + grid.gapY))
}

/** The pixel width of one column in a grid of the given total width. */
export function columnWidth(width: number, dense = false): number {
  return (width - (GRID_COLUMNS - 1) * gridOf(dense).gapX) / GRID_COLUMNS
}
