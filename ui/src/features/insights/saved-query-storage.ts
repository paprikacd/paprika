import type { InsightsClient } from "./client";
import {
  savedQuerySchema,
  type Dashboard,
  type SavedQueryEntry,
  type SavedQuery,
} from "./schema";
import {
  dashboardUsesSavedQuery,
  validateSavedQueryTemplate,
} from "./saved-queries";
import { savedQueryCompatibility } from "./import-review";

export const EXAMPLE_SAVED_QUERIES_KEY = "paprika.insights.example-queries.v1";
export type SavedQueryClient = Pick<
  InsightsClient,
  "listSavedQueries" | "getSavedQuery" | "saveSavedQuery" | "removeSavedQuery"
>;

function checkSize(query: unknown) {
  if (new TextEncoder().encode(JSON.stringify(query)).byteLength > 32 * 1024)
    throw new Error("Saved queries must be smaller than 32 KiB.");
}

/** Example data stays in its own browser workspace, never in the connected service. */
export function createExampleSavedQueryClient(
  storage: Pick<Storage, "getItem" | "setItem">,
  dashboards: () => Dashboard[],
  initialQueries: readonly SavedQuery[] = [],
): SavedQueryClient {
  const read = (): SavedQueryEntry[] => {
    const source = storage.getItem(EXAMPLE_SAVED_QUERIES_KEY);
    const entries: unknown = source === null ? initialQueries.map(query => ({...query,etag: seedETag(query)})) : JSON.parse(source);
    if (!Array.isArray(entries) || entries.length > 256)
      throw new Error("The example saved-query library is invalid.");
    const ids = new Set<string>();
    const validated = entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("The example saved-query library is invalid.");
      const { etag, ...document } = entry;
      checkSize(document);
      const query = savedQuerySchema.parse(document);
      validateSavedQueryTemplate(query);
      if (ids.has(query.id) || typeof etag !== "string" || !etag.length)
        throw new Error("The example saved-query library is invalid.");
      ids.add(query.id);
      return { ...query, etag };
    });
    // The library outlives dashboard references. Materialize its initial
    // snapshot once so removing a dashboard cannot remove orphaned queries.
    if (source === null && initialQueries.length > 0)
      storage.setItem(EXAMPLE_SAVED_QUERIES_KEY, JSON.stringify(validated));
    return validated;
  };
  return {
    listSavedQueries: async () => read(),
    getSavedQuery: async (id) => {
      const found = read().find((query) => query.id === id);
      if (!found) throw new Error("Saved query not found.");
      const { etag, ...query } = found;
      return { query, etag };
    },
    saveSavedQuery: async (input, etag) => {
      const query = savedQuerySchema.parse(input);
      validateSavedQueryTemplate(query);
      checkSize(query);
      const entries = read();
      const old = entries.find((entry) => entry.id === query.id);
      if ((old && old.etag !== etag) || (!old && etag))
        throw new Error("This saved query changed. Reload it before saving.");
      if (
        old &&
        (old.providerId !== query.providerId || old.kind !== query.kind)
      )
        throw new Error(
          "Create a new saved query to change its data source or kind.",
        );
      if (old) {
        const compatibility = savedQueryCompatibility(query, dashboards(), old);
        if (!compatibility.compatible)
          throw new Error(
            `This saved query change would break a dashboard reference. ${compatibility.reason}`,
          );
      }
      if (!old && entries.length >= 256)
        throw new Error("The saved-query library supports up to 256 entries.");
      const nextTag = `"example-${crypto.randomUUID()}"`;
      storage.setItem(
        EXAMPLE_SAVED_QUERIES_KEY,
        JSON.stringify([
          ...entries.filter((entry) => entry.id !== query.id),
          { ...query, etag: nextTag },
        ]),
      );
      return nextTag;
    },
    removeSavedQuery: async (id, etag) => {
      const entries = read();
      const old = entries.find((entry) => entry.id === id);
      if (!old) throw new Error("Saved query not found.");
      if (!etag || old.etag !== etag)
        throw new Error("This saved query changed. Reload it before deleting.");
      if (
        dashboards().some((dashboard) => dashboardUsesSavedQuery(dashboard, id))
      )
        throw new Error(
          "This saved query is used by a dashboard. Switch its widgets to custom queries before deleting it.",
        );
      storage.setItem(
        EXAMPLE_SAVED_QUERIES_KEY,
        JSON.stringify(entries.filter((entry) => entry.id !== id)),
      );
    },
  };
}

function seedETag(query: SavedQuery) {
  let hash = 2166136261;
  for (const char of JSON.stringify(query)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `"example-seed-${query.id}-${(hash >>> 0).toString(16)}"`;
}
