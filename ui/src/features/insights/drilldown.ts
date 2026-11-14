import {
  customTimeRangeSchema,
  dashboardSchema,
  drilldownSchema,
  timeRanges,
  variableNameSchema,
  variableValueSchema,
  MAX_DASHBOARD_VARIABLES,
  type Dashboard,
  type Drilldown,
  type DrilldownBinding,
} from "./schema"

export type VariableValues = Record<string, string>
export interface DrilldownContext {
  labels?: Record<string, string>
  value?: number | null
  series?: string
  /** Exact selected observation time in milliseconds, when deliberately chosen. */
  timestamp?: number
}
/** Relative windows a view can choose; the same presets the saved dashboard uses. */
export type ViewTimeRange = Dashboard["timeRange"]
/** Auto refresh in seconds; 0 turns it off for this view. */
export type ViewRefresh = Dashboard["refreshInterval"]
export interface DashboardNavigation {
  dashboardId: string
  variables?: VariableValues
  /** A fixed window. Mutually exclusive with `range`. */
  customTimeRange?: { from: string; to: string }
  /** A relative window chosen in the view. Overrides the saved preset until cleared. */
  range?: ViewTimeRange
  /** Auto refresh chosen in the view. Absent means the saved interval applies. */
  refresh?: ViewRefresh
}
/** A link part that was malformed. It is reported and not applied; the rest of the link still opens. */
export type RejectedLinkPart =
  | { kind: "variable"; name: string }
  | { kind: "setting"; name: "range" | "refresh"; value: string }
/** A link part the open dashboard did not apply, with the reason shown in the notice. */
export type IgnoredLink =
  | { kind: "variable"; name: string; reason: "undeclared" | "invalid" }
  | { kind: "setting"; name: "range" | "refresh"; value: string }
/** A link as read from the address: its valid view plus the parts that were malformed. */
export interface ParsedDashboardLink {
  navigation: DashboardNavigation | null
  rejected: RejectedLinkPart[]
}
export const MAX_DASHBOARD_URL_LENGTH = 8192
const RANGE_PRESETS = Object.keys(timeRanges) as ViewTimeRange[]
const REFRESH_SECONDS = ["0", "15", "30", "60"] as const

function checkedValues(input: unknown): VariableValues {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Dashboard variables must be a JSON object")
  const entries = Object.entries(input)
  if (entries.length > MAX_DASHBOARD_VARIABLES)
    throw new Error("A dashboard can use at most 20 variable values")
  return Object.fromEntries(
    entries.map(([key, value]) => [
      variableNameSchema.parse(key),
      variableValueSchema.parse(value),
    ]),
  )
}

export function resolveDashboardVariables(
  dashboard: Pick<Dashboard, "variables">,
  overrides: VariableValues = {},
): VariableValues {
  const values = checkedValues(overrides)
  const definitions = dashboard.variables ?? []
  const known = new Set(definitions.map((variable) => variable.name))
  for (const key of Object.keys(values))
    if (!known.has(key))
      throw new Error(`Dashboard variable “${key}” is not declared by this dashboard`)
  return Object.fromEntries(
    definitions.flatMap((variable) => {
      const value = Object.hasOwn(values, variable.name)
        ? values[variable.name]
        : variable.defaultValue
      return value === undefined ? [] : [[variable.name, variableValueSchema.parse(value)]]
    }),
  )
}

/** Values are complete quoted literals, never raw query fragments or string fragments. */
export function interpolateQuery(query: string, variables: VariableValues): string {
  return interpolateLiterals(query, checkedValues(variables))
}

/** Tooltip observations may also supply finite numeric literals, never query syntax. */
export function interpolateQueryLiterals(query: string, variables: Record<string, string | number>): string {
  if (!variables || typeof variables !== "object" || Array.isArray(variables))
    throw new Error("Query variables must be a JSON object")
  const entries = Object.entries(variables)
  if (entries.length > MAX_DASHBOARD_VARIABLES)
    throw new Error("A query can use at most 20 variable values")
  const values = Object.fromEntries(entries.map(([name, value]) => {
    variableNameSchema.parse(name)
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Query variable “${name}” must be finite`)
      return [name, value]
    }
    return [name, variableValueSchema.parse(value)]
  }))
  return interpolateLiterals(query, values)
}

function interpolateLiterals(query: string, values: Record<string, string | number>): string {
  if (query.length > 8192) throw new Error("Queries must be at most 8192 characters")
  let output = ""
  let quote: '"' | "'" | "`" | null = null
  let comment: "line" | "block" | null = null
  let escaped = false
  for (let index = 0; index < query.length; index++) {
    const char = query[index]
    const next = query[index + 1]
    if (char === "{" && next === "{") {
      const end = query.indexOf("}}", index + 2)
      if (end === -1) throw new Error("Finish the dashboard variable placeholder with }}")
      const name = query.slice(index + 2, end)
      if (!variableNameSchema.safeParse(name).success)
        throw new Error(`Invalid dashboard variable placeholder “${name}”`)
      if (quote)
        throw new Error(
          `Remove the surrounding quotes from {{${name}}}; a variable supplies a complete numeric or quoted string value`,
        )
      if (comment) throw new Error(`Move {{${name}}} out of the query comment before using it`)
      const before = query[index - 1]
      const after = query[end + 2]
      const numeric = typeof values[name] === "number"
      if (
        (before && !(numeric ? /[\s\[(=~!<>:,|&+\-*/%^@]/ : /[\s\[(=~!<>:,|&]/).test(before)) ||
        (after && !/[\s,})\]|&!<>=:+\-*/%^]/.test(after))
      )
        throw new Error(`Use {{${name}}} as a complete literal value, not part of a token`)
      if (!Object.hasOwn(values, name))
        throw new Error(`Set dashboard variable “${name}” before running this query`)
      output += JSON.stringify(values[name])
      index = end + 1
      continue
    }
    output += char
    if (comment === "line") {
      if (char === "\n" || char === "\r") comment = null
      continue
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        output += next
        index++
        comment = null
      }
      continue
    }
    if (quote) {
      if (quote !== "`" && escaped) escaped = false
      else if (quote !== "`" && char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "#" || (char === "/" && next === "/")) comment = "line"
    else if (char === "/" && next === "*") {
      output += next
      index++
      comment = "block"
    }
  }
  if (output.length > 8192)
    throw new Error("The query exceeds 8192 characters after inserting dashboard variables")
  return output
}

export function resolveDrilldown(
  drilldown: Drilldown,
  context: DrilldownContext,
  target: Dashboard,
  currentBounds?: { start: number; end: number },
): DashboardNavigation {
  const link = drilldownSchema.parse(drilldown)
  if (target.id !== link.dashboardId)
    throw new Error("The drilldown target dashboard does not match the configured link")
  const overrides: VariableValues = {}
  for (const binding of link.bindings ?? []) {
    let value: string
    if (binding.source === "constant") value = binding.value!
    else if (binding.source === "label") {
      if (!context.labels || !Object.hasOwn(context.labels, binding.value!))
        throw new Error(
          `This signal has no label “${binding.value}” for variable “${binding.variable}”`,
        )
      value = context.labels[binding.value!]
    } else if (binding.source === "series") {
      if (context.series === undefined)
        throw new Error(`Select a series to set variable “${binding.variable}”`)
      value = context.series
    } else {
      if (typeof context.value !== "number" || !Number.isFinite(context.value))
        throw new Error(`This signal has no finite value for variable “${binding.variable}”`)
      value = String(context.value)
    }
    overrides[binding.variable] = variableValueSchema.parse(value)
  }
  const navigation: DashboardNavigation = {
    dashboardId: target.id,
    variables: resolveDashboardVariables(target, overrides),
  }
  if (link.carryTimeRange !== false) {
    if (
      !currentBounds ||
      !Number.isFinite(currentBounds.start) ||
      !Number.isFinite(currentBounds.end)
    )
      throw new Error("The current time range is unavailable for this drilldown")
    try {
      navigation.customTimeRange = customTimeRangeSchema.parse({
        from: new Date(currentBounds.start * 1000).toISOString(),
        to: new Date(currentBounds.end * 1000).toISOString(),
      })
    } catch {
      throw new Error("Drilldowns require an increasing current time range of at most 31 days")
    }
  }
  return navigation
}

/** Apply a deliberate selection atomically, retaining other current filters. */
export function resolveSelectionBindings(
  bindings: DrilldownBinding[], context: DrilldownContext, dashboard: Dashboard, current: VariableValues,
): VariableValues {
  const resolved = resolveDrilldown({ id: "selection", title: "Selection", dashboardId: dashboard.id, carryTimeRange: false, bindings }, context, dashboard)
  const selected = Object.fromEntries(bindings.map(binding => [binding.variable, resolved.variables![binding.variable]]))
  return resolveDashboardVariables(dashboard, { ...current, ...selected })
}

function checkedNavigation(input: DashboardNavigation): DashboardNavigation {
  if (input.range !== undefined && input.customTimeRange !== undefined)
    throw new Error("Choose either a time range preset or a fixed window, not both")
  return {
    dashboardId: dashboardSchema.shape.id.parse(input.dashboardId),
    ...(input.variables === undefined ? {} : { variables: checkedValues(input.variables) }),
    ...(input.customTimeRange === undefined
      ? {}
      : { customTimeRange: customTimeRangeSchema.parse(input.customTimeRange) }),
    ...(input.range === undefined ? {} : { range: checkedRangePreset(input.range) }),
    ...(input.refresh === undefined ? {} : { refresh: checkedRefresh(input.refresh) }),
  }
}

function checkedRangePreset(value: unknown): ViewTimeRange {
  if (typeof value !== "string" || !RANGE_PRESETS.includes(value as ViewTimeRange))
    throw new Error(`Dashboard URL time range must be one of ${RANGE_PRESETS.join(", ")}`)
  return value as ViewTimeRange
}

function checkedRefresh(value: unknown): ViewRefresh {
  const text = typeof value === "number" ? String(value) : value
  if (typeof text !== "string" || !(REFRESH_SECONDS as readonly string[]).includes(text))
    throw new Error("Dashboard URL refresh must be 0, 15, 30 or 60 seconds")
  return Number(text) as ViewRefresh
}

export function buildDashboardURL(
  input: DashboardNavigation,
  basePath = "/dashboard/insights/",
): string {
  const parts = basePath.split("/")
  if (
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    /[\\?#]/.test(basePath) ||
    parts
      .slice(1, basePath.endsWith("/") ? -1 : undefined)
      .some((part) => !/^[A-Za-z0-9._~-]+$/.test(part) || part === "." || part === "..") ||
    !/\/dashboard\/insights\/?$/.test(basePath)
  )
    throw new Error("Dashboard links must use a local Insights route")
  const state = checkedNavigation(input)
  const search = new URLSearchParams({ dashboard: state.dashboardId })
  if (state.variables && Object.keys(state.variables).length)
    search.set(
      "vars",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(state.variables).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
  if (state.customTimeRange) {
    search.set("from", state.customTimeRange.from)
    search.set("to", state.customTimeRange.to)
  }
  if (state.range) search.set("range", state.range)
  if (state.refresh !== undefined) search.set("refresh", String(state.refresh))
  const url = `${basePath.endsWith("/") ? basePath : `${basePath}/`}?${search}`
  if (url.length > MAX_DASHBOARD_URL_LENGTH)
    throw new Error("This dashboard link exceeds the 8192-character URL limit")
  return url
}

/**
 * Reads a link from the address. Structure is strict: a repeated parameter, malformed
 * variable JSON, too many variable values, a window with only one end, a window
 * combined with a preset, and links longer than the URL limit throw. A malformed
 * variable name or value, or an unknown range or refresh value, is not fatal: it is
 * listed in `rejected` so the view can say so, and the rest of the link still applies.
 */
export function parseDashboardLink(search: string): ParsedDashboardLink {
  if (search.length > MAX_DASHBOARD_URL_LENGTH || (search && !search.startsWith("?")))
    throw new Error("Dashboard URL parameters are invalid or too long")
  const params = new URLSearchParams(search)
  for (const name of ["dashboard", "vars", "from", "to", "range", "refresh"])
    if (params.getAll(name).length > 1) throw new Error(`Dashboard URL repeats “${name}”`)
  const dashboardId = params.get("dashboard")
  if (dashboardId === null) {
    if (["vars", "from", "to", "range", "refresh"].some((name) => params.has(name)))
      throw new Error("Choose a dashboard before passing variables or a time range")
    return { navigation: null, rejected: [] }
  }
  let variables: VariableValues | undefined
  const rejected: RejectedLinkPart[] = []
  if (params.has("vars")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(params.get("vars")!)
    } catch {
      throw new Error("Dashboard URL variables must be valid named string values")
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Dashboard URL variables must be valid named string values")
    const entries = Object.entries(parsed)
    if (entries.length > MAX_DASHBOARD_VARIABLES)
      throw new Error("A dashboard can use at most 20 variable values")
    variables = {}
    for (const [key, value] of entries) {
      const name = variableNameSchema.safeParse(key), text = variableValueSchema.safeParse(value)
      if (name.success && text.success) variables[key] = text.data
      else rejected.push({ kind: "variable", name: key })
    }
  }
  const hasFrom = params.has("from"),
    hasTo = params.has("to")
  if (hasFrom !== hasTo) throw new Error("Dashboard URL time ranges require both from and to")
  const rangeText = params.get("range"), refreshText = params.get("refresh")
  const range = rangeText === null ? undefined : (RANGE_PRESETS as string[]).includes(rangeText) ? rangeText as ViewTimeRange : undefined
  if (rangeText !== null && range === undefined) rejected.push({ kind: "setting", name: "range", value: rangeText })
  const refresh = refreshText === null ? undefined : (REFRESH_SECONDS as readonly string[]).includes(refreshText) ? Number(refreshText) as ViewRefresh : undefined
  if (refreshText !== null && refresh === undefined) rejected.push({ kind: "setting", name: "refresh", value: refreshText })
  if (range !== undefined && hasFrom) throw new Error("Choose either a time range preset or from and to, not both")
  const navigation = checkedNavigation({
    dashboardId,
    variables,
    ...(hasFrom ? { customTimeRange: { from: params.get("from")!, to: params.get("to")! } } : {}),
    ...(range === undefined ? {} : { range }),
    ...(refresh === undefined ? {} : { refresh }),
  })
  return { navigation, rejected }
}

/** The view a link describes, for callers that do not show notices. Malformed parts are dropped. */
export function parseDashboardURL(search: string): DashboardNavigation | null {
  return parseDashboardLink(search).navigation
}

/**
 * Applies a link to the document it opens. Values for variables the document no
 * longer declares are dropped, and malformed parts are reported, so the view keeps
 * only what this dashboard can use.
 */
export function resolveLinkView(
  document: Pick<Dashboard, "variables">,
  link: DashboardNavigation,
  rejected: RejectedLinkPart[] = [],
): { state: DashboardNavigation; ignored: IgnoredLink[] } {
  const declared = new Set((document.variables ?? []).map((variable) => variable.name))
  const { variables, ...rest } = link
  const ignored: IgnoredLink[] = [
    ...Object.keys(variables ?? {})
      .filter((name) => !declared.has(name))
      .map((name) => ({ kind: "variable" as const, name, reason: "undeclared" as const })),
    ...rejected.map((part): IgnoredLink =>
      part.kind === "variable"
        ? { kind: "variable", name: part.name, reason: "invalid" }
        : { kind: "setting", name: part.name, value: part.value }),
  ]
  if (variables === undefined) return { state: rest, ignored }
  const kept = Object.fromEntries(Object.entries(variables).filter(([name]) => declared.has(name)))
  return { state: { ...rest, variables: kept }, ignored }
}

const RANGE_CHOICES = "15m, 30m, 1h, 6h, 24h, 7d or 30d"
const REFRESH_CHOICES = "0, 15, 30 or 60 seconds"

/** Plain-language notice for link parts that were not applied. Empty when none were ignored. */
export function describeIgnoredLink(ignored: IgnoredLink[]): string {
  const label = (name: string) => `“${name.length > 64 ? `${name.slice(0, 63)}…` : name}”`
  const list = (names: string[], noun: [string, string]) => {
    const shown = names.slice(0, 5).map(label).join(", ")
    const more = names.length > 5 ? `, and ${names.length - 5} more` : ""
    return names.length === 1 ? `${noun[0]} ${shown}` : `${noun[1]} ${shown}${more}`
  }
  const undeclared = ignored.flatMap(item => item.kind === "variable" && item.reason === "undeclared" ? [item.name] : [])
  const invalid = ignored.flatMap(item => item.kind === "variable" && item.reason === "invalid" ? [item.name] : [])
  const settings = ignored.flatMap(item => item.kind === "setting" ? [item] : [])
  const parts: string[] = []
  if (undeclared.length) {
    parts.push(`Ignored ${list(undeclared, ["link filter", "link filters"])}: ${undeclared.length === 1 ? "this dashboard no longer declares it." : "this dashboard no longer declares them."}`)
  }
  if (invalid.length) {
    parts.push(`Ignored ${list(invalid, ["link filter", "link filters"])} because ${invalid.length === 1 ? "its name or value is" : "their names or values are"} not valid.`)
  }
  for (const setting of settings) {
    parts.push(setting.name === "range"
      ? `Ignored link time range ${label(setting.value)}: use ${RANGE_CHOICES}.`
      : `Ignored link refresh ${label(setting.value)}: use ${REFRESH_CHOICES}.`)
  }
  return parts.join(" ")
}
