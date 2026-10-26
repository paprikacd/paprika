import { describe, expect, it } from "vitest";
import { savedQuerySchema, type SavedQuery } from "./schema";
import { buildDashboardBundle, parseDashboardBundle, savedQueryFingerprint, serializeDashboardBundle } from "./workspace-transfer";
import { resolveSavedQueryTemplate } from "./saved-queries";

const query: SavedQuery = {
  schemaVersion: 1, id: "requests", name: "Requests", providerId: "metrics", kind: "metrics", query: "up",
  description: "Production services", imageUrl: "https://images.example.com/cover.png?size=80", tags: ["production", "availability"], metadata: { team: "platform", documentation: "https://docs.example.com" },
};

describe("saved query library metadata", () => {
  it("accepts absent or empty optional collections and exact UTF-16 limits", () => {
    expect(savedQuerySchema.parse(query)).toEqual(query);
    expect(savedQuerySchema.parse({ ...query, imageUrl: undefined, tags: [], metadata: {} })).toMatchObject({ tags: [], metadata: {} });
    expect(savedQuerySchema.safeParse({ ...query, tags: ["🫑".repeat(16)], metadata: { ["🫑".repeat(32)]: "🫑".repeat(128) } }).success).toBe(true);
    expect(savedQuerySchema.safeParse({ ...query, tags: ["🫑".repeat(17)] }).success).toBe(false);
  });

  it.each([
    { imageUrl: null }, { imageUrl: "" }, { imageUrl: "http://images.example.com/a.png" },
    { imageUrl: "//images.example.com/a.png" }, { imageUrl: "https:///images.example.com/a.png" },
    { imageUrl: "data:image/png;base64,aA==" }, { imageUrl: "javascript:alert(1)" },
    { imageUrl: "https://user:password@images.example.com/a.png" }, { imageUrl: "https://@images.example.com/a.png" },
    { imageUrl: "https://images.example.com:65536/a.png" }, { imageUrl: "https://images.example.com/a\nb.png" },
    { imageUrl: "/\\images.example.com/a.png" }, { imageUrl: "/a".repeat(1025) },
    { tags: null }, { tags: "production" }, { tags: [null] }, { tags: [""] }, { tags: [" production"] },
    { tags: ["production", "production"] }, { tags: ["x".repeat(33)] }, { tags: Array.from({ length: 13 }, (_, i) => String(i)) },
    { metadata: null }, { metadata: [] }, { metadata: { team: null } }, { metadata: { team: 4 } },
    { metadata: { "": "empty" } }, { metadata: { "team ": "platform" } }, { metadata: { ["k".repeat(65)]: "value" } },
    { metadata: { team: "x".repeat(257) } }, { metadata: { constructor: "reserved" } },
    { metadata: JSON.parse('{"__proto__":"reserved"}') },
    { metadata: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`key${i}`, "value"])) },
  ])("rejects invalid or unsafe library details: %j", (patch) => {
    expect(savedQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
  });

  it.each(["/images/cover.png", "/images/cover.svg?size=80", "https://images.example.com:443/cover.png", "https://[::1]/cover.png"])("accepts a safe image URL: %s", (imageUrl) => {
    expect(savedQuerySchema.safeParse({ ...query, imageUrl }).success).toBe(true);
  });

  it.each(["json", "yaml"] as const)("preserves rich metadata in %s bundle round trips without changing query execution", (format) => {
    const bundle = buildDashboardBundle([{
      schemaVersion: 1, id: "overview", title: "Overview", timeRange: "1h", refreshInterval: 0,
      widgets: [{ id: "requests", title: "Requests", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 3, h: 3 }, queryRef: { id: query.id } }],
    }], [query]);
    expect(parseDashboardBundle(serializeDashboardBundle(bundle, format), format).savedQueries).toEqual([query]);
    expect(resolveSavedQueryTemplate(query, {})).toBe("up");
  });

  it("includes presentation changes in exact save confirmation fingerprints", () => {
    for (const patch of [{ description: "Changed" }, { imageUrl: "/changed.png" }, { tags: ["new"] }, { metadata: { team: "other" } }])
      expect(savedQueryFingerprint({ ...query, ...patch })).not.toBe(savedQueryFingerprint(query));
  });
});
