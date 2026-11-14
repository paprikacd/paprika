import { seriesName, type Series } from "./chart-data";
import type { Widget } from "./schema";

// Only shorten the canonical name produced from provider labels. User-authored
// aliases and unfamiliar naming conventions keep their original text.
function isGeneratedName(series: Series) {
  const labels = series.labels ?? {};
  const fields = Object.keys(labels).filter(key => key !== "__name__").sort();
  if (!fields.length) return false;
  const canonical = `${labels.__name__ ?? ""}{${fields.map(key => `${key}=${JSON.stringify(labels[key])}`).join(", ")}}`;
  return series.name === canonical;
}

// Fallback names the server or chart assigns when a series has no identity of its own.
// Authored and provider-specific names never match, so they are always kept.
const GENERIC_NAME = /^(Value|Series \d+)$/;
function isGenericSeriesName(name: string) {
  return GENERIC_NAME.test(name);
}

const preferred = ["pod", "container", "service", "namespace", "node", "instance", "job"];
const priority = (key: string) => {
  const index = preferred.indexOf(key);
  return index < 0 ? preferred.length : index;
};

/** Visual labels only: identities, query bindings and accessible details remain unchanged. */
export function compactSeriesLabels(series: readonly Series[]): string[] {
  const originals = series.map(seriesName);
  const generated = series.map((entry, index) => isGeneratedName(entry) ? index : -1).filter(index => index >= 0);
  // With no peers there is no evidence that one field is the intended name.
  if (generated.length < 2) return originals;
  const candidates = [...new Set(generated.flatMap(index => Object.keys(series[index].labels ?? {})))].filter(key => key !== "__name__")
    .sort((a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0));
  const metrics = new Set(generated.map(index => series[index].labels?.__name__));
  const selected: string[] = metrics.size > 1 ? ["__name__"] : [];
  const collisions = (keys: string[]) => {
    const groups = new Map<string, number>();
    for (const index of generated) {
      const tuple = JSON.stringify(keys.map(key => series[index].labels?.[key] ?? null));
      groups.set(tuple, (groups.get(tuple) ?? 0) + 1);
    }
    return [...groups.values()].reduce((total, count) => total + count * (count - 1) / 2, 0);
  };
  // Choose the label that separates the most remaining pairs; prefer shorter
  // identifiers when two fields distinguish the same number of series.
  while (candidates.length) {
    let best = 0, remaining = Infinity, length = Infinity;
    candidates.forEach((key, index) => {
      const count = collisions([...selected, key]);
      const textLength = generated.reduce((sum, row) => sum + (series[row].labels?.[key]?.length ?? 256), 0);
      if (count < remaining || (count === remaining && textLength < length)) { remaining = count; length = textLength; best = index; }
    });
    if (selected.some(key => key !== "__name__") && remaining >= collisions(selected)) break;
    selected.push(candidates.splice(best, 1)[0]);
    if (remaining === 0) break;
  }
  if (!selected.length) return originals;
  const normal = selected.filter(key => key !== "__name__").sort((a, b) => priority(a) - priority(b) || (a < b ? -1 : a > b ? 1 : 0));
  const displayKeys = selected.includes("__name__") ? ["__name__", ...normal] : normal;
  const labels = originals.map((original, index) => {
    if (!generated.includes(index)) return original;
    const values = displayKeys.map(key => series[index].labels?.[key]);
    if (values.some(value => value === undefined || value === "")) return original;
    return displayKeys.map((key, i) => key === "__name__" || normal.length === 1 ? values[i] : `${key}=${values[i]}`).join(" · ");
  });
  // If compact labels collide, show the full original rather than inventing
  // an identity or merging independent observations in the visual legend.
  return labels.map((label, index) => generated.includes(index) && labels.some((other, otherIndex) => otherIndex !== index && other === label) ? originals[index] : label);
}

// Group and column labels are joined with this separator (see record-charts.tsx plotData).
const SEGMENT_SEPARATOR = " · ";

/**
 * Removes one leading and one trailing segment that every name shares. Cuts
 * fall only between " · " segments, so decimals, addresses, signs, hostnames,
 * versions, emoji and combining marks are never split. A cut that leaves a
 * name without a segment, an empty name, or two names that look the same is
 * rejected and the names are returned as written.
 */
function stripSharedSegments(names: readonly string[]): string[] {
  let parts = names.map(name => name.split(SEGMENT_SEPARATOR));
  const usable = (candidate: string[][]) => {
    const labels = candidate.map(segments => segments.join(SEGMENT_SEPARATOR).trim());
    return labels.every(Boolean) && new Set(labels).size === labels.length;
  };
  if (parts.every(segments => segments.length > 1) && parts.every(segments => segments[0] === parts[0][0])) {
    const next = parts.map(segments => segments.slice(1));
    if (usable(next)) parts = next;
  }
  if (parts.every(segments => segments.length > 1) && parts.every(segments => segments.at(-1) === parts[0].at(-1))) {
    const next = parts.map(segments => segments.slice(0, -1));
    if (usable(next)) parts = next;
  }
  return parts.map(segments => segments.join(SEGMENT_SEPARATOR));
}

/** Explorer previews are identified by their query selector, never by a title fallback. */
export const EXPLORER_PREVIEW_WIDGET_ID = "explore-preview";

/**
 * The authored title that identifies a lone series whose own name is only a
 * fallback ("Value", "Series N", or an untransformed selector). Only dashboard
 * widgets with an authored title qualify; the author's words are used, never
 * a label field guessed from the data. Returns undefined otherwise.
 */
export function fallbackIdentityTitle(widget: Pick<Widget, "id" | "title">, series: readonly Series[]): string | undefined {
  const title = widget.title?.trim() ?? "";
  if (!title || widget.id === EXPLORER_PREVIEW_WIDGET_ID || series.length !== 1) return undefined;
  const generic = isGenericSeriesName(seriesName(series[0], 0)) || isGeneratedName(series[0]);
  return generic ? title : undefined;
}

/**
 * Visible names for a chart's legend and tooltips. Several series keep
 * compacted labels, or drop one leading and one trailing " · " segment they
 * all share. Full names stay on the series for titles, inspectors and aria text.
 */
export function displaySeriesNames(series: readonly Series[]): string[] {
  const originals = series.map(seriesName);
  if (series.length < 2) return originals;
  const compacted = compactSeriesLabels(series);
  // Compacted labels already name the fields that differ; trimming them again would drop a key.
  if (compacted.some((label, index) => label !== originals[index]) || originals.some(isGenericSeriesName)) return compacted;
  return stripSharedSegments(originals);
}
