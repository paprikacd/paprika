import { describe, expect, it } from "vitest"
import { resolveSavedQueryTemplate, validateSavedQueryTemplate } from "./saved-queries"
import type { SavedQuery } from "./schema"

const sqlQuery = (parameters: Record<string, unknown>[]) => ({
  schemaVersion: 1,
  id: "hosts",
  name: "Hosts",
  providerId: "records",
  kind: "records",
  query: `{"sql":"SELECT host FROM hosts WHERE ($1::text[] IS NULL OR zone = ANY($1::text[]))","parameters":[{{zone}}]}`,
  parameters,
}) as unknown as SavedQuery

const zones = { name: "zone", type: "string", multi: true, defaultValue: [] }

describe("saved query list parameters", () => {
  it("binds a list as a SQL text array", () => {
    const query = sqlQuery([zones])
    expect(resolveSavedQueryTemplate(query, { zone: ["omega", "delta"] })).toBe(
      `{"sql":"SELECT host FROM hosts WHERE ($1::text[] IS NULL OR zone = ANY($1::text[]))","parameters":[["omega","delta"]]}`,
    )
  })

  it("binds All as NULL", () => {
    const query = sqlQuery([zones])
    expect(resolveSavedQueryTemplate(query, { zone: [] })).toContain(`"parameters":[null]`)
  })

  it("wraps a single string for a list parameter", () => {
    const query = sqlQuery([zones])
    expect(resolveSavedQueryTemplate(query, { zone: "omega" })).toContain(`"parameters":[["omega"]]`)
  })

  it("refuses a list for a single-value parameter", () => {
    const query = sqlQuery([{ name: "zone", type: "string" }])
    expect(() => resolveSavedQueryTemplate(query, { zone: ["omega"] })).toThrow()
  })

  it("accepts the list template when validated", () => {
    expect(() => validateSavedQueryTemplate(sqlQuery([zones]))).not.toThrow()
  })

  it("refuses a list after equality when validated", () => {
    const query = {
      ...sqlQuery([zones]),
      query: "up{zone={{zone}}}",
      kind: "metrics",
      providerId: "prometheus",
    } as unknown as SavedQuery
    expect(() => validateSavedQueryTemplate(query)).toThrow()
  })
})
