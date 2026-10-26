import {
  customTimeRangeSchema,
  dashboardSchema,
  drilldownSchema,
  variableNameSchema,
  variableValueSchema,
  MAX_DASHBOARD_VARIABLES,
  type Dashboard,
  type Drilldown,
} from "./schema"

export type VariableValues = Record<string, string>
export interface DrilldownContext {
  labels?: Record<string, string>
  value?: number | null
  series?: string
}
export interface DashboardNavigation {
  dashboardId: string
  variables?: VariableValues
  customTimeRange?: { from: string; to: string }
}
export const MAX_DASHBOARD_URL_LENGTH = 8192

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
        (before && !(numeric ? /[\s(=~!<>:,|&+\-*/%^@]/ : /[\s(=~!<>:,|&]/).test(before)) ||
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

function checkedNavigation(input: DashboardNavigation): DashboardNavigation {
  return {
    dashboardId: dashboardSchema.shape.id.parse(input.dashboardId),
    ...(input.variables === undefined ? {} : { variables: checkedValues(input.variables) }),
    ...(input.customTimeRange === undefined
      ? {}
      : { customTimeRange: customTimeRangeSchema.parse(input.customTimeRange) }),
  }
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
  const url = `${basePath.endsWith("/") ? basePath : `${basePath}/`}?${search}`
  if (url.length > MAX_DASHBOARD_URL_LENGTH)
    throw new Error("This dashboard link exceeds the 8192-character URL limit")
  return url
}

export function parseDashboardURL(search: string): DashboardNavigation | null {
  if (search.length > MAX_DASHBOARD_URL_LENGTH || (search && !search.startsWith("?")))
    throw new Error("Dashboard URL parameters are invalid or too long")
  const params = new URLSearchParams(search)
  for (const name of ["dashboard", "vars", "from", "to"])
    if (params.getAll(name).length > 1) throw new Error(`Dashboard URL repeats “${name}”`)
  const dashboardId = params.get("dashboard")
  if (dashboardId === null) {
    if (["vars", "from", "to"].some((name) => params.has(name)))
      throw new Error("Choose a dashboard before passing variables or a time range")
    return null
  }
  let variables: VariableValues | undefined
  if (params.has("vars")) {
    try {
      variables = checkedValues(JSON.parse(params.get("vars")!))
    } catch {
      throw new Error("Dashboard URL variables must be valid named string values")
    }
  }
  const hasFrom = params.has("from"),
    hasTo = params.has("to")
  if (hasFrom !== hasTo) throw new Error("Dashboard URL time ranges require both from and to")
  return checkedNavigation({
    dashboardId,
    variables,
    ...(hasFrom ? { customTimeRange: { from: params.get("from")!, to: params.get("to")! } } : {}),
  })
}
