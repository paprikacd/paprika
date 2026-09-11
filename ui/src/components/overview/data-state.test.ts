import { describe, expect, it } from "vitest"

import { DataClass, DataSourceStatus, DataState } from "@/gen/paprika/v1/api_pb"

import {
  dataStateOf,
  formatAge,
  formatDuration,
  indexDataSources,
  isStale,
  isUnavailable,
  numbersAreReal,
  plural,
  surfaceExists,
} from "./data-state"

describe("surfaceExists", () => {
  it("keeps surfaces whose data class answers, however badly", () => {
    expect(surfaceExists(DataState.OK)).toBe(true)
    expect(surfaceExists(DataState.STALE)).toBe(true)
    expect(surfaceExists(DataState.NOT_AVAILABLE)).toBe(true)
    expect(surfaceExists(DataState.ERROR)).toBe(true)
  })

  it("removes surfaces nothing is configured to produce", () => {
    expect(surfaceExists(DataState.NOT_CONFIGURED)).toBe(false)
  })

  it("removes surfaces the caller may not see, without implying absence", () => {
    expect(surfaceExists(DataState.FORBIDDEN)).toBe(false)
  })

  it("removes a surface it has been told nothing about", () => {
    expect(surfaceExists(undefined)).toBe(false)
    expect(surfaceExists(DataState.UNSPECIFIED)).toBe(false)
  })
})

describe("numbersAreReal", () => {
  it("accepts the two states the server populates numerics in", () => {
    expect(numbersAreReal(DataState.OK)).toBe(true)
    expect(numbersAreReal(DataState.STALE)).toBe(true)
  })

  it("rejects every state whose numerics the server zeroes", () => {
    for (const state of [
      DataState.NOT_CONFIGURED,
      DataState.NOT_AVAILABLE,
      DataState.ERROR,
      DataState.FORBIDDEN,
      DataState.UNSPECIFIED,
    ]) {
      expect(numbersAreReal(state)).toBe(false)
    }
  })
})

describe("isStale / isUnavailable", () => {
  it("separates a stale sample from a missing one", () => {
    expect(isStale(DataState.STALE)).toBe(true)
    expect(isUnavailable(DataState.STALE)).toBe(false)
    expect(isUnavailable(DataState.NOT_AVAILABLE)).toBe(true)
    expect(isUnavailable(DataState.ERROR)).toBe(true)
  })
})

describe("indexDataSources", () => {
  it("indexes the fixed per-class response by class", () => {
    const index = indexDataSources([
      new DataSourceStatus({
        dataClass: DataClass.COST,
        state: DataState.NOT_CONFIGURED,
      }),
      new DataSourceStatus({
        dataClass: DataClass.LIFECYCLE,
        state: DataState.OK,
      }),
    ])
    expect(dataStateOf(index, DataClass.COST)).toBe(DataState.NOT_CONFIGURED)
    expect(dataStateOf(index, DataClass.LIFECYCLE)).toBe(DataState.OK)
  })

  it("reports nothing for a class the server never mentioned", () => {
    expect(dataStateOf(indexDataSources([]), DataClass.SOURCE_EVENTS)).toBe(
      undefined
    )
  })
})

describe("formatAge", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0)

  it("says how old a sample is the way an operator would", () => {
    expect(formatAge(now - 6 * 60_000, now)).toBe("6m")
    expect(formatAge(now - 72 * 60_000, now)).toBe("1h 12m")
    expect(formatAge(now - 2 * 60 * 60_000, now)).toBe("2h")
    expect(formatAge(now - 50 * 60 * 60_000, now)).toBe("2d")
  })

  it("refuses to read an absent timestamp as 'now'", () => {
    expect(formatAge(undefined, now)).toBe("unknown")
    expect(formatAge(BigInt(0), now)).toBe("unknown")
  })
})

describe("formatDuration", () => {
  it("formats a recorded duration", () => {
    expect(formatDuration(24 * 60_000)).toBe("24m")
    expect(formatDuration(BigInt(63 * 60_000))).toBe("1h 3m")
  })
})

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(1, "application")).toBe("application")
    expect(plural(2, "application")).toBe("applications")
    expect(plural(0, "application")).toBe("applications")
  })
})
