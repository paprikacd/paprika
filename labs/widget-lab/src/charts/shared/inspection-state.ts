export type InspectionState = { hover: string | null; pinned: string | null };
export type InspectionSource = { revision: unknown; externalSelection?: string };

/** Resolve against the current result before paint, including linked selection echoes. */
export function resolveInspectionState<T extends { id: string }>(
  state: InspectionState,
  previous: InspectionSource,
  current: InspectionSource,
  items: readonly T[],
  enabled: boolean,
  selectionKey: (item: T) => string,
): InspectionState {
  if (!enabled || previous.revision !== current.revision) return { hover: null, pinned: null };
  const selected = items.find(item => item.id === state.pinned);
  const selectionChanged = previous.externalSelection !== current.externalSelection;
  const echoedPin = selected && current.externalSelection !== undefined
    && selectionKey(selected) === current.externalSelection;
  return {
    hover: !selectionChanged && items.some(item => item.id === state.hover) ? state.hover : null,
    pinned: selected && (!selectionChanged || echoedPin) ? state.pinned : null,
  };
}
