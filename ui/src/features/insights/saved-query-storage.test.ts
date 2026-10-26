import { describe, expect, it, vi } from "vitest";
import {
  createExampleSavedQueryClient,
  EXAMPLE_SAVED_QUERIES_KEY,
} from "./saved-query-storage";
import type { Dashboard, SavedQuery, SavedQueryEntry } from "./schema";

const query: SavedQuery = {
  schemaVersion: 1,
  id: "requests",
  name: "Requests",
  providerId: "prom",
  kind: "metrics",
  query: "requests{service={{service}}}",
  parameters: [{ name: "service", type: "string", defaultValue: "api" }],
};
function storage(initial: string | null = null) {
  let current = initial;
  return {
    getItem: vi.fn(() => current),
    setItem: vi.fn((_key: string, value: string) => {
      current = value;
    }),
  };
}
const dashboard = (reference: "parent" | "tooltip"): Dashboard => ({
  schemaVersion: 1,
  id: "overview",
  title: "Overview",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [
    {
      id: "metric",
      title: "Metric",
      type: "heatmap",
      providerId: "prom",
      query: "up",
      unit: "",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      ...(reference === "parent"
        ? { queryRef: { id: query.id } }
        : {
            options: {
              showTooltip: false,
              tooltipView: {
                type: "stat",
                source: { type: "saved", ref: { id: query.id } },
              },
            },
          }),
    },
  ],
});

describe("example saved-query storage", () => {
  it("persists create/read/update/delete across client reload with opaque fresh revision tags", async () => {
    const store = storage();
    const client = createExampleSavedQueryClient(store, () => []);
    expect(await client.listSavedQueries()).toEqual([]);
    const first = await client.saveSavedQuery(query);
    expect(first).toMatch(/^"example-[^"]+"$/);
    expect(store.setItem).toHaveBeenLastCalledWith(
      EXAMPLE_SAVED_QUERIES_KEY,
      expect.any(String),
    );
    const reloaded = createExampleSavedQueryClient(store, () => []);
    expect(await reloaded.getSavedQuery(query.id)).toEqual({
      query,
      etag: first,
    });
    expect(await reloaded.listSavedQueries()).toEqual([
      { ...query, etag: first },
    ]);
    const update = {
      ...query,
      name: "Updated requests",
      query: "sum(requests{service={{service}}})",
    };
    const second = await reloaded.saveSavedQuery(update, first);
    expect(second).not.toBe(first);
    expect(await client.getSavedQuery(query.id)).toEqual({
      query: update,
      etag: second,
    });
    await client.removeSavedQuery(query.id, second);
    expect(await reloaded.listSavedQueries()).toEqual([]);
    await expect(reloaded.getSavedQuery(query.id)).rejects.toThrow(/not found/);
  });
  it("rejects stale writes, stale deletes, duplicate creation and missing-document update without modifying storage", async () => {
    const store = storage();
    const a = createExampleSavedQueryClient(store, () => []),
      b = createExampleSavedQueryClient(store, () => []);
    const first = await a.saveSavedQuery(query);
    const second = await b.saveSavedQuery(
      { ...query, name: "Other editor" },
      first,
    );
    store.setItem.mockClear();
    await expect(
      a.saveSavedQuery({ ...query, name: "Stale edit" }, first),
    ).rejects.toThrow(/changed/);
    await expect(a.saveSavedQuery(query)).rejects.toThrow(/changed/);
    await expect(a.removeSavedQuery(query.id, first)).rejects.toThrow(
      /changed/,
    );
    await expect(
      a.saveSavedQuery({ ...query, id: "missing" }, first),
    ).rejects.toThrow(/changed/);
    await expect(a.removeSavedQuery("missing", second)).rejects.toThrow(
      /not found/,
    );
    expect(store.setItem).not.toHaveBeenCalled();
    expect((await a.getSavedQuery(query.id)).query.name).toBe("Other editor");
  });
  it("allows only one same-revision writer and enforces immutable provider/kind", async () => {
    const store = storage();
    const client = createExampleSavedQueryClient(store, () => []);
    const tag = await client.saveSavedQuery(query);
    const outcomes = await Promise.allSettled([
      client.saveSavedQuery({ ...query, name: "A" }, tag),
      client.saveSavedQuery({ ...query, name: "B" }, tag),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const current = await client.getSavedQuery(query.id);
    store.setItem.mockClear();
    await expect(
      client.saveSavedQuery({ ...query, providerId: "other" }, current.etag),
    ).rejects.toThrow(/new saved query/);
    await expect(
      client.saveSavedQuery({ ...query, kind: "traces" }, current.etag),
    ).rejects.toThrow(/new saved query/);
    expect(store.setItem).not.toHaveBeenCalled();
  });
  it.each(["parent", "tooltip"] as const)(
    "blocks deletion used by a %s reference and allows it after unlinking",
    async (reference) => {
      let dashboards = [dashboard(reference)];
      const store = storage();
      const client = createExampleSavedQueryClient(store, () => dashboards);
      const tag = await client.saveSavedQuery(query);
      store.setItem.mockClear();
      await expect(client.removeSavedQuery(query.id, tag)).rejects.toThrow(
        /used by a dashboard/,
      );
      expect(store.setItem).not.toHaveBeenCalled();
      dashboards = [];
      await client.removeSavedQuery(query.id, tag);
      expect(await client.listSavedQueries()).toEqual([]);
    },
  );
  it.each(["parent", "tooltip"] as const)(
    "rejects a replacement that newly breaks a persisted %s binding and preserves its revision",
    async (reference) => {
      const documents = [dashboard(reference)];
      const store = storage();
      const client = createExampleSavedQueryClient(store, () => documents);
      const etag = await client.saveSavedQuery(query);
      store.setItem.mockClear();
      await expect(
        client.saveSavedQuery(
          { ...query, parameters: [{ name: "service", type: "string" }] },
          etag,
        ),
      ).rejects.toThrow(/break a dashboard reference[\s\S]*Required parameter/);
      expect(store.setItem).not.toHaveBeenCalled();
      expect(await client.getSavedQuery(query.id)).toEqual({ query, etag });
      const renamed = {
        ...query,
        name: "Renamed",
        query: "sum(requests{service={{service}}})",
      };
      await client.saveSavedQuery(renamed, etag);
      expect((await client.getSavedQuery(query.id)).query).toEqual(renamed);
    },
  );
  it("allows harmless edits with a pre-existing broken reference but blocks new dynamic binding type changes", async () => {
    const document = dashboard("parent");
    document.variables = [{ name: "service", defaultValue: "1" }];
    document.widgets[0].queryRef!.bindings = [
      { parameter: "service", source: "variable", variable: "service" },
      { parameter: "missing", source: "constant", value: "pre-existing" },
    ];
    const store = storage();
    const client = createExampleSavedQueryClient(store, () => [document]);
    const first = await client.saveSavedQuery(query);
    const changed = { ...query, name: "Harmless name update" };
    const second = await client.saveSavedQuery(changed, first);
    store.setItem.mockClear();
    await expect(
      client.saveSavedQuery(
        {
          ...changed,
          parameters: [{ name: "service", type: "number", defaultValue: 1 }],
        },
        second,
      ),
    ).rejects.toThrow(/dashboard-variable.*contract/);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(await client.getSavedQuery(query.id)).toEqual({
      query: changed,
      etag: second,
    });
  });
  it("enforces the 256-entry capacity while allowing updates and reuse after deletion", async () => {
    const entries: SavedQueryEntry[] = Array.from(
      { length: 256 },
      (_, index) => ({
        ...query,
        id: `query-${index}`,
        etag: `"version-${index}"`,
      }),
    );
    const store = storage(JSON.stringify(entries));
    const client = createExampleSavedQueryClient(store, () => []);
    await expect(client.saveSavedQuery(query)).rejects.toThrow(/256/);
    expect(store.setItem).not.toHaveBeenCalled();
    await client.saveSavedQuery(
      { ...query, id: "query-0", name: "Updated" },
      entries[0].etag,
    );
    await client.removeSavedQuery("query-1", entries[1].etag);
    await client.saveSavedQuery(query);
    expect(await client.listSavedQueries()).toHaveLength(256);
  });
  it("rejects invalid templates and UTF-8 documents over 32 KiB before writing", async () => {
    const store = storage();
    const client = createExampleSavedQueryClient(store, () => []);
    await expect(
      client.saveSavedQuery({
        ...query,
        query: 'requests{service="{{service}}"}',
      }),
    ).rejects.toThrow(/quotes/);
    const oversized: SavedQuery = {
      ...query,
      query: `up{label="${"界".repeat(7000)}"}`,
      parameters: Array.from({ length: 20 }, (_, index) => ({
        name: `p${index}`,
        type: "string",
        defaultValue: "x".repeat(1024),
      })),
    };
    await expect(client.saveSavedQuery(oversized)).rejects.toThrow(/32 KiB/);
    expect(store.setItem).not.toHaveBeenCalled();
  });
  it.each([
    "not-json",
    "null",
    "{}",
    "[null]",
    JSON.stringify([
      { ...query, etag: "tag" },
      { ...query, etag: "tag2" },
    ]),
    JSON.stringify([{ ...query }]),
    JSON.stringify([{ ...query, etag: "" }]),
    JSON.stringify([
      { ...query, etag: "tag", query: 'requests{service="{{service}}"}' },
    ]),
    JSON.stringify(
      Array.from({ length: 257 }, (_, index) => ({
        ...query,
        id: `q-${index}`,
        etag: "tag",
      })),
    ),
  ])(
    "rejects corrupt persisted libraries without clearing them: %s",
    async (raw) => {
      const store = storage(raw);
      const client = createExampleSavedQueryClient(store, () => []);
      await expect(client.listSavedQueries()).rejects.toThrow();
      await expect(
        client.saveSavedQuery({ ...query, id: "new" }),
      ).rejects.toThrow();
      expect(store.setItem).not.toHaveBeenCalled();
      expect(store.getItem()).toBe(raw);
    },
  );
  it("rejects oversized persisted documents on reload without overwriting them", async () => {
    const oversized = {
      ...query,
      query: `up{label="${"界".repeat(7000)}"}`,
      parameters: Array.from({ length: 20 }, (_, index) => ({
        name: `p${index}`,
        type: "string",
        defaultValue: "x".repeat(1024),
      })),
      etag: '"version"',
    };
    const raw = JSON.stringify([oversized]);
    const store = storage(raw);
    const client = createExampleSavedQueryClient(store, () => []);
    await expect(client.listSavedQueries()).rejects.toThrow(/32 KiB/);
    await expect(
      client.saveSavedQuery({ ...query, id: "new" }),
    ).rejects.toThrow(/32 KiB/);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.getItem()).toBe(raw);
  });
  it("propagates read/write failures and retains existing saved documents on quota failure", async () => {
    const store = storage();
    const client = createExampleSavedQueryClient(store, () => []);
    const tag = await client.saveSavedQuery(query);
    store.setItem.mockImplementationOnce(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    await expect(
      client.saveSavedQuery({ ...query, name: "Lost update" }, tag),
    ).rejects.toThrow(/Storage full/);
    expect((await client.getSavedQuery(query.id)).query).toEqual(query);
    store.getItem.mockImplementationOnce(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    await expect(client.listSavedQueries()).rejects.toThrow(/Denied/);
  });
});
