/**
 * The first control matching `selector` that is shown. The Edit chip is hidden on a narrow tile, where the actions trigger
 * takes its place, so a focus target chosen by id must skip the hidden one: focus() on a hidden element does nothing.
 */
export function visibleTileControl(scope: ParentNode, selector: string): HTMLElement | null {
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>(selector))) {
    if (element.checkVisibility?.() !== false) return element;
  }
  return null;
}
