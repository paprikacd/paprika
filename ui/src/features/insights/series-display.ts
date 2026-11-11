import { seriesName, type Series } from "./chart-data";

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
export function isGenericSeriesName(name: string) {
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

const isSeparator = (char: string) => !/[\p{L}\p{N}]/u.test(char);

/**
 * Removes one prefix and one suffix that every name shares, cut only at a
 * separator so "cpu_usage"/"cpu_load" loses "cpu_" but "sale"/"rate" with a
 * shared "s" does not lose letters. Gives up on a cut that leaves an empty or
 * duplicate name, so the caller's names are returned unchanged.
 */
function stripSharedAffixes(names: readonly string[]): string[] {
  if (names.length < 2) return [...names];
  const shared = (values: readonly string[]) => values.reduce((acc, value) => {
    let i = 0;
    while (i < acc.length && i < value.length && acc[i] === value[i]) i++;
    return acc.slice(0, i);
  });
  const reversed = (value: string) => [...value].reverse().join("");
  const usable = (values: readonly string[]) => {
    const trimmed = values.map(value => value.trim());
    return trimmed.every(Boolean) && new Set(trimmed).size === trimmed.length;
  };
  let result = [...names];
  // Suffix first: " · short_interest" is the shared tail in the Market Lens legend.
  const tail = reversed(shared(result.map(reversed)));
  const suffixStart = [...tail].findIndex(isSeparator);
  if (suffixStart >= 0) {
    const cut = tail.slice(suffixStart);
    const next = result.map(name => name.slice(0, name.length - cut.length));
    if (usable(next)) result = next.map(name => name.trim());
  }
  const head = shared(result);
  let prefixEnd = -1;
  [...head].forEach((char, index) => { if (isSeparator(char)) prefixEnd = index; });
  if (prefixEnd >= 0) {
    const cut = head.slice(0, prefixEnd + 1);
    const next = result.map(name => name.slice(cut.length));
    if (usable(next)) result = next.map(name => name.trim());
  }
  return result;
}

/**
 * Names for a chart's legend. A lone series whose name is a fallback (or an
 * untransformed selector) takes the widget's authored title; that is the
 * author's own identity, not a label field guessed from the data. Several
 * series keep compacted labels, or lose a prefix and suffix they all share.
 * Full names stay on the series for tooltips, inspectors and aria-labels.
 */
export function displaySeriesNames(series: readonly Series[], widgetTitle = ""): string[] {
  const originals = series.map(seriesName);
  if (series.length === 1) {
    const title = widgetTitle.trim();
    const fallback = isGenericSeriesName(originals[0]) || isGeneratedName(series[0]);
    return fallback && title ? [title] : originals;
  }
  const compacted = compactSeriesLabels(series);
  // Compacted labels already name the fields that differ; trimming them again would drop a key.
  if (compacted.some((label, index) => label !== originals[index]) || originals.some(isGenericSeriesName)) return compacted;
  return stripSharedAffixes(originals);
}
