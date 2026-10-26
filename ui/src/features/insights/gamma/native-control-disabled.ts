/** Include inherited fieldset state for controls whose choices live in a portal. */
export function nativeControlDisabled(
  control: HTMLButtonElement | HTMLInputElement | null,
): boolean {
  if (!control) return false;
  if (control.disabled) return true;
  for (
    let parent = control.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (parent instanceof HTMLFieldSetElement && parent.disabled) {
      const firstLegend = [...parent.children].find(
        (child) => child.tagName === "LEGEND",
      );
      if (!firstLegend?.contains(control)) return true;
    }
  }
  return false;
}
