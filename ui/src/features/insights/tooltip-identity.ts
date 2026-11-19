/**
 * Stable keys for rows or cells whose display names can repeat (two monitors called "api", or two history rows with the
 * same label field). The first occurrence keeps its name; later ones get `#2`, `#3`, so a pin cannot resolve to a
 * neighbour that happens to share the name.
 */
export function occurrenceKeys(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(name => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}#${count}`;
  });
}
