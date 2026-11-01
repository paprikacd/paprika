import { afterEach, describe, expect, it, vi } from "vitest"
import { browserTimeZone, resolveDashboardTimeZone } from "./dashboard-time-zone"
import { timeZones } from "./time-zones.generated"
import { dashboardSchema, isCanonicalTimeZone, isValidTimeZone, newDashboard, storedDashboardSchema } from "./schema"

const dashboard = (timeZone: unknown) => ({ ...newDashboard(), id: "zoned", title: "Zoned", timeZone })

afterEach(() => vi.restoreAllMocks())

describe("canonical time zone list", () => {
  it("lists each IANA name once, in byte order, without offsets, Local, Factory or posixrules", () => {
    expect([...timeZones]).toEqual([...timeZones].sort())
    expect(new Set(timeZones).size).toBe(timeZones.length)
    for (const name of ["Local", "localtime", "Factory", "posixrules"]) expect(timeZones).not.toContain(name)
    expect(timeZones.some((zone) => /^[+-]/.test(zone))).toBe(false)
    expect(timeZones).toEqual(expect.arrayContaining(["UTC", "Europe/London", "America/New_York", "Asia/Kolkata"]))
  })

  it("matches exactly and case-sensitively, so the save path refuses what the server refuses", () => {
    for (const zone of ["+05:30", "-08:00", "gmt", "us/pacific", "zulu", "etc/utc", "europe/london", "asia/kolkata", "utc", "Utc", "Local", "Factory", "posixrules", "localtime", " UTC", "UTC ", "Mars/Olympus", ""]) {
      expect(isCanonicalTimeZone(zone), zone).toBe(false)
      expect(dashboardSchema.safeParse(dashboard(zone)).success, zone).toBe(false)
    }
  })

  it("accepts canonical names, including the links and Etc/GMT names that both runtimes already accepted", () => {
    for (const zone of ["UTC", "GMT", "Zulu", "Etc/UTC", "Etc/GMT+5", "Europe/London", "America/New_York", "Asia/Kolkata", "Asia/Calcutta", "US/Pacific"]) {
      expect(isCanonicalTimeZone(zone), zone).toBe(true)
      expect(dashboardSchema.safeParse(dashboard(zone)).success, zone).toBe(true)
    }
  })

  it("names the published rule in the refusal", () => {
    const result = dashboardSchema.safeParse(dashboard("+05:30"))
    expect(result.success ? "" : result.error.issues[0].message).toBe("Use an IANA time zone name, such as Europe/London or UTC")
  })
})

describe("reading a stored time zone", () => {
  it("keeps a stored zone as saved, so one stale value never fails the document", () => {
    for (const zone of ["Factory", "+05:30", "gmt", "Mars/Olympus"]) expect(storedDashboardSchema.parse(dashboard(zone)).timeZone, zone).toBe(zone)
  })

  it("drops a value that is not a bounded string, and still checks every other field", () => {
    expect(storedDashboardSchema.parse(dashboard(5)).timeZone).toBeUndefined()
    expect(storedDashboardSchema.parse(dashboard("x".repeat(65))).timeZone).toBeUndefined()
    expect(storedDashboardSchema.safeParse({ ...dashboard("UTC"), timeRange: "2y" }).success).toBe(false)
  })

  it("renders a stored zone the server would refuse with the viewer's zone, instead of formatting with it", () => {
    expect(resolveDashboardTimeZone("Factory")).toBe(browserTimeZone())
    expect(resolveDashboardTimeZone("+05:30")).toBe(browserTimeZone())
    expect(resolveDashboardTimeZone("UTC")).toBe("UTC")
  })
})

describe("runtime formatting", () => {
  it("validates on the canonical list, and falls back at render for a name this runtime cannot format", () => {
    const formatter = Intl.DateTimeFormat
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((locales, options) => {
      if (options?.timeZone === "Pacific/Chatham") throw new RangeError("Invalid time zone specified: Pacific/Chatham")
      return new formatter(locales, options)
    })
    // An older browser's ICU data can lack a newer canonical name. Saving follows the list; rendering falls back.
    expect(isCanonicalTimeZone("Pacific/Chatham")).toBe(true)
    expect(dashboardSchema.safeParse(dashboard("Pacific/Chatham")).success).toBe(true)
    expect(isValidTimeZone("Pacific/Chatham")).toBe(false)
    expect(resolveDashboardTimeZone("Pacific/Chatham")).toBe(browserTimeZone())
  })
})
