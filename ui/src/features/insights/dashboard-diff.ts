// Positional JSON diff, shared by the import review (eager) and dashboard-patch.ts (on demand). No imports and only
// erasable TypeScript syntax, so Node loads it directly. It is kept apart from dashboard-patch.ts so that the
// first view, which reviews imports, does not also carry the widget_edits merge.

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }
export type JSONObject = { [key: string]: JSONValue }
export interface FieldChange {
  path: string
  kind: "add" | "remove" | "change" | "reorder"
  before?: JSONValue
  after?: JSONValue
}
export interface JSONDiff {
  changes: FieldChange[]
  totalChanges: number
  truncated: boolean
}

export const MAX_DIFF_CHANGES = 200

function isObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Positional diff of two JSON values. Objects are compared by key and collections named widgets, drilldowns, parameters, variables or bindings by identity. */
export function diffJSON(before: JSONValue | undefined, after: JSONValue | undefined): JSONDiff {
  const changes: FieldChange[] = []
  let totalChanges = 0
  const record = (change: FieldChange) => {
    totalChanges++
    if (changes.length < MAX_DIFF_CHANGES) changes.push(change)
  }
  const walk = (previous: JSONValue | undefined, next: JSONValue | undefined, path: string, name: string) => {
    if (previous === next) return
    if (previous === undefined) {
      record({ path: path || "$", kind: "add", after: next })
      return
    }
    if (next === undefined) {
      record({ path: path || "$", kind: "remove", before: previous })
      return
    }
    if (Array.isArray(previous) && Array.isArray(next)) {
      const key = collectionKey(name, previous, next)
      if (key) {
        const entries = (items: JSONValue[]) => new Map(items.map((item) => [(item as Record<string, JSONValue>)[key] as string, item]))
        const oldItems = entries(previous)
        const newItems = entries(next)
        const oldOrder = [...oldItems.keys()].filter((id) => newItems.has(id))
        const newOrder = [...newItems.keys()].filter((id) => oldItems.has(id))
        if (oldOrder.some((id, index) => id !== newOrder[index]))
          record({ path, kind: "reorder", before: [...oldItems.keys()], after: [...newItems.keys()] })
        for (const id of new Set([...oldItems.keys(), ...newItems.keys()]))
          walk(oldItems.get(id), newItems.get(id), `${path}[${key}=${id}]`, "")
      } else {
        for (let index = 0; index < Math.max(previous.length, next.length); index++) walk(previous[index], next[index], `${path}[${index}]`, "")
      }
      return
    }
    if (isObject(previous) && isObject(next)) {
      for (const key of [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort())
        walk(Object.hasOwn(previous, key) ? previous[key] : undefined, Object.hasOwn(next, key) ? next[key] : undefined, propertyPath(path, key), key)
      return
    }
    record({ path: path || "$", kind: "change", before: previous, after: next })
  }
  walk(before, after, "", "")
  return { changes, totalChanges, truncated: totalChanges > changes.length }
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`
}

function collectionKey(name: string, before: JSONValue[], after: JSONValue[]): string | undefined {
  const candidates = name === "widgets" || name === "drilldowns" ? ["id"] : name === "parameters" || name === "variables" ? ["name"] : name === "bindings" ? ["parameter", "variable"] : []
  return candidates.find((key) => {
    if (!before.length && !after.length) return false
    return [before, after].every((items) => {
      const seen = new Set<string>()
      return items.every((item) => {
        if (!isObject(item) || typeof item[key] !== "string" || seen.has(item[key] as string)) return false
        seen.add(item[key] as string)
        return true
      })
    })
  })
}
