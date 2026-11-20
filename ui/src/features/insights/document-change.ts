import type { Dashboard } from "./schema";

export interface DocumentChangeSummary {
  added: number;
  changed: number;
  removed: number;
}

/**
 * Counts the widget changes that replacing `before` with `after` would make, matched by widget id.
 * A widget present only in `after` is added, one present only in `before` is removed, and one present
 * in both is changed when its JSON differs. Duplicate ids match the first widget with that id.
 */
export function documentChangeSummary(
  before: Dashboard,
  after: Dashboard,
): DocumentChangeSummary {
  const previous = new Map<string, Dashboard["widgets"][number]>();
  for (const widget of before.widgets) {
    if (!previous.has(widget.id)) previous.set(widget.id, widget);
  }
  const nextIds = new Set(after.widgets.map((widget) => widget.id));
  let added = 0;
  let changed = 0;
  for (const widget of after.widgets) {
    const prior = previous.get(widget.id);
    if (!prior) added++;
    else if (JSON.stringify(prior) !== JSON.stringify(widget)) changed++;
  }
  const removed = before.widgets.filter((widget) => !nextIds.has(widget.id)).length;
  return { added, changed, removed };
}

export function documentChangeText(change: DocumentChangeSummary): string {
  return `${change.added} added · ${change.changed} changed · ${change.removed} removed`;
}
