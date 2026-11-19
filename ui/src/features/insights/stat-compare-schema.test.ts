import { describe, expect, it } from "vitest"
import { widgetSchema } from "./schema"

const base = { id: "rate", title: "Rate", providerId: "p", query: "q", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 2 } }

describe("stat comparison schema", () => {
  it("accepts a stat with an earlier window and an optional direction", () => {
    expect(widgetSchema.safeParse({ ...base, type: "stat", options: { compare: { window: "1d", good: "down" } } }).success).toBe(true)
    expect(widgetSchema.safeParse({ ...base, type: "stat", options: { compare: { window: "previous" } } }).success).toBe(true)
  })
  it("rejects a comparison on any other widget, at the options member", () => {
    const result = widgetSchema.safeParse({ ...base, type: "timeseries", options: { compare: { window: "previous" } } })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({ path: ["options", "compare"] })
  })
  it("rejects windows and directions outside the closed sets", () => {
    expect(widgetSchema.safeParse({ ...base, type: "stat", options: { compare: { window: "2d" } } }).success).toBe(false)
    expect(widgetSchema.safeParse({ ...base, type: "stat", options: { compare: { window: "1d", good: "none" } } }).success).toBe(false)
    expect(widgetSchema.safeParse({ ...base, type: "stat", options: { compare: { window: "1d", colour: "green" } } }).success).toBe(false)
  })
})
