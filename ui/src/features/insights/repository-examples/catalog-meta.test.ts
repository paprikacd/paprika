import { describe, expect, it } from "vitest"
import meta from "./catalog-meta.json"
import { repositoryExamples } from "."

// catalog-meta.json feeds the sidebar badge without loading the catalog. generate.py writes it; this keeps it honest.
describe("example catalog metadata", () => {
  it("matches the full catalog so the sidebar count and ids cannot drift", () => {
    expect(meta.count).toBe(repositoryExamples.length)
    expect(meta.ids).toEqual(repositoryExamples.map(entry => entry.id))
  })
})
