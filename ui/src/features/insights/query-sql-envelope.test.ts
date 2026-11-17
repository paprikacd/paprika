import { describe, expect, it } from "vitest"
import { assertProviderQueryTemplate, jsonObjectFragments } from "./provider-query-template"
import { readSQLQuery, sqlQueryIssue, writeSQLQuery } from "./query-sql-envelope"
import { resolveSavedQueryTemplate } from "./saved-queries"
import type { SavedQuery } from "./schema"

const source = '{"sql":"SELECT value FROM events WHERE service=$1 AND value>$2","parameters":[{{service}}, {{minimum}}],"projection":{"value":"value"}}'
const parameters = [{ name: "service", type: "string" as const }, { name: "minimum", type: "number" as const }]

describe("PostgreSQL authored templates", () => {
  it("keeps the SQL body fixed while hostile string data stays in prepared parameters", () => {
    const hostile = 'api\'; DELETE FROM events; -- \\" {{minimum}}'
    const query: SavedQuery = { schemaVersion: 1, id: "sql", name: "SQL", providerId: "pg", kind: "metrics", query: source, parameters }
    expect(() => assertProviderQueryTemplate("postgresql", source)).not.toThrow()
    const bound = JSON.parse(resolveSavedQueryTemplate(query, { service: hostile, minimum: 2.5 }))
    expect(bound.sql).toBe("SELECT value FROM events WHERE service=$1 AND value>$2")
    expect(bound.parameters).toEqual([hostile, 2.5])
    expect(bound.projection).toEqual({ value: "value" })
  })

  it.each([
    'SELECT value WHERE service={{service}}',
    '{"sql":"SELECT {{service}}","parameters":[]}',
    '{"sql":"SELECT $1","parameters":["{{service}}"]}',
    '{"sql":"SELECT $1","parameters":[{{service}}],"projection":{"value":{{minimum}}}}',
    '{"sql":"SELECT $1","parameters":[{{service}}],"sql":"SELECT 99"}',
    '{"sql":"SELECT $1","parameters":[{{service}}]',
  ])("rejects unsafe or ambiguous template placement: %s", query => {
    expect(() => assertProviderQueryTemplate("postgresql", query)).toThrow(/parameters array/)
  })

  it("does not reject other provider languages or native SQL without interpolation", () => {
    expect(() => assertProviderQueryTemplate("prometheus", 'up{service={{service}}}')).not.toThrow()
    expect(() => assertProviderQueryTemplate("uptime", '{"args":{"serviceId":{{service}}}}')).not.toThrow()
    expect(() => assertProviderQueryTemplate("postgresql", 'SELECT 1 AS value')).not.toThrow()
  })
})

describe("SQL editor envelope", () => {
  it("round trips raw bindings and metric projection without changing their types", () => {
    const draft = readSQLQuery(source, parameters)
    expect(draft.sql).toContain("service=$1")
    expect(draft.parameters).toBe("[{{service}}, {{minimum}}]")
    expect(sqlQueryIssue(draft, parameters)).toBe("")
    const changed = writeSQLQuery({ ...draft, sql: draft.sql + " ORDER BY value" })
    expect(jsonObjectFragments(changed).get("parameters")).toBe(draft.parameters)
    expect(readSQLQuery(changed, parameters).projection).toBe(draft.projection)
  })

  it("keeps unparameterized SQL native until bindings or projection are added", () => {
    const draft = readSQLQuery("SELECT 1 AS value")
    expect(writeSQLQuery(draft)).toBe("SELECT 1 AS value")
    const bound = writeSQLQuery({ ...draft, sql: "SELECT $1 AS value", parameters: "[1.5]", envelope: true })
    expect(JSON.parse(bound)).toEqual({ sql: "SELECT $1 AS value", parameters: [1.5] })
  })

  it.each([
    ["", "Write an SQL"],
    ["SELECT {{service}}", "Use $1"],
  ])("explains invalid native SQL drafts: %s", (sql, reason) => {
    expect(sqlQueryIssue(readSQLQuery(sql), parameters)).toContain(reason)
  })

  it("preserves incomplete or duplicate-key JSON for repair instead of discarding fields", () => {
    for (const value of ['{"sql":', '{"sql":"SELECT 1","sql":"SELECT 2"}', '{"sql":"SELECT 1","extra":true}']) {
      const draft = readSQLQuery(value)
      expect(draft.raw).toBe(value)
      expect(writeSQLQuery(draft)).toBe(value)
      expect(sqlQueryIssue(draft)).toContain("Fix its JSON")
    }
  })

  it("rejects nested, excessive, quoted-template or incomplete bindings", () => {
    const draft = readSQLQuery(source, parameters)
    for (const values of ['[{"a":1}]', '[[1]]', '[' + '1,'.repeat(64) + '1]', '["{{service}}"]', '[{{service}}'])
      expect(sqlQueryIssue({ ...draft, parameters: values }, parameters)).not.toBe("")
    expect(sqlQueryIssue({ ...draft, parameters: '[null, false, 0, ""]' }, parameters)).toBe("")
  })

  it("accepts only explicit start and end range references alongside typed parameters", () => {
    const draft = readSQLQuery(source, parameters)
    const bound = { ...draft, parameters: '[{{service}}, {"range":"start"}, {"range":"end"}]' }
    expect(sqlQueryIssue(bound, parameters)).toBe("")
    expect(jsonObjectFragments(writeSQLQuery(bound)).get("parameters")).toBe(bound.parameters)
    for (const invalid of ['[{"range":"now"}]', '[{"range":[]}]', '[{"range":"start","extra":1}]'])
      expect(sqlQueryIssue({ ...draft, parameters: invalid }, parameters)).not.toBe("")
  })

  it("rejects metric projection on records and supports removing it without changing SQL", () => {
    const draft = readSQLQuery(source, parameters)
    expect(sqlQueryIssue(draft, parameters, true)).toContain("Remove the metric projection")
    expect(sqlQueryIssue({ ...draft, projection: "" }, parameters, true)).toBe("")
    expect(JSON.parse(writeSQLQuery({ ...draft, parameters: "[]", projection: "" }))).not.toHaveProperty("projection")
  })
})
