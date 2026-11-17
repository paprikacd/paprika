/** Why an observation tooltip closed. Passive reasons never move focus; explicit ones return it to the opener. */
export type TooltipDismissReason = "outside" | "blur" | "superseded" | "escape" | "close";
type FocusTarget = Pick<HTMLElement, "isConnected" | "focus">;

// Dismissal callbacks run synchronously, so a counter is enough. Nested owners
// inherit the outer dismissal's policy, including an explicit close inside it.
let passiveDepth = 0;
let restoringDepth = 0;
const passiveReasons: ReadonlySet<TooltipDismissReason> = new Set(["outside", "blur", "superseded"]);

/** True only while a restore's own focus call is running, so focus handlers can ignore that echo. */
export const isRestoringTooltipFocus = () => restoringDepth > 0;

export function withTooltipDismissReason<T>(reason: TooltipDismissReason, dismiss: () => T): T {
  const passive = passiveReasons.has(reason);
  if (passive) passiveDepth++;
  try {
    return dismiss();
  } finally {
    if (passive) passiveDepth--;
  }
}

/** Close and Escape return focus to the opener. Passive dismissal keeps the user's new focus target. */
export function restoreTooltipFocus(target: FocusTarget | null | undefined): boolean {
  if (passiveDepth || !target?.isConnected) return false;
  restoringDepth++;
  try {
    target.focus({ preventScroll: true });
  } finally {
    restoringDepth--;
  }
  return true;
}

/** The control a keyboard user returns to: the anchor, or the focusable element that contains it. */
export function tooltipFocusOwner(anchor: Element | null | undefined): HTMLElement | SVGElement | null {
  if (!anchor) return null;
  // A container with tabindex -1 can take focus programmatically, but it is not a control to return to.
  return anchor.closest<HTMLElement | SVGElement>("button,a[href],input,select,textarea,summary,[tabindex]:not([tabindex='-1'])") ?? (anchor as HTMLElement | SVGElement);
}
