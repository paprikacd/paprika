export type TooltipDismissReason = 'outside' | 'superseded' | 'escape' | 'close';
type FocusTarget = Pick<HTMLElement, 'isConnected' | 'focus'>;

// Dismiss callbacks are synchronous. Nested owners retain the outer pointer
// event's focus policy, including when an inner owner performs an explicit close.
let passiveDismissalDepth = 0;
let restoringFocusDepth = 0;
export const isRestoringTooltipFocus = () => restoringFocusDepth > 0;

export function withTooltipDismissReason<T>(reason: TooltipDismissReason, dismiss: () => T): T {
  const passive = reason === 'outside' || reason === 'superseded';
  if (passive) passiveDismissalDepth++;
  try { return dismiss(); }
  finally { if (passive) passiveDismissalDepth--; }
}

/** Close/Escape returns focus; passive dismissal keeps the user's new focus target. */
export function restoreTooltipFocus(target: FocusTarget | null | undefined): boolean {
  if (passiveDismissalDepth || !target?.isConnected) return false;
  restoringFocusDepth++;
  try { target.focus({ preventScroll: true }); }
  finally { restoringFocusDepth--; }
  return true;
}
