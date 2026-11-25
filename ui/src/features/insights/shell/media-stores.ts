// Desktop compact chrome is a view preference, independent of measured canvas
// width so expanding navigation cannot repeatedly toggle the rail.
export const compactDesktopQuery = "(min-width: 1024px)";

export function subscribeCompactDesktop(listener: () => void) {
  const media = window.matchMedia(compactDesktopQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export const compactDesktopSnapshot = () => window.matchMedia(compactDesktopQuery).matches;

export const compactDesktopServerSnapshot = () => false;

export function subscribeFinePointer(listener: () => void) {
  const media = window.matchMedia("(pointer: fine)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

export const finePointerSnapshot = () => window.matchMedia("(pointer: fine)").matches;
