import type { WidgetOptions } from "./schema";

export const DEFAULT_WIDGET_TEXT = "#27332e";
export const DEFAULT_WIDGET_BACKGROUND = "#ffffff";

function luminance(color: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/** WCAG relative-luminance ratio for the schema's opaque six-digit colors. */
export function contrastRatio(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function readableTextColor(background: string) {
  if (contrastRatio(DEFAULT_WIDGET_TEXT, background) >= 4.5)
    return DEFAULT_WIDGET_TEXT;
  if (contrastRatio("#ffffff", background) >= 4.5) return "#ffffff";
  // Mid-tone backgrounds can fail with both Gamma ink and white.
  return "#000000";
}

/** Keep explicit imported choices; adapt only the default foreground. */
export function widgetTextColor(options?: WidgetOptions) {
  return (
    options?.textColor ??
    (options?.background ? readableTextColor(options.background) : undefined)
  );
}
