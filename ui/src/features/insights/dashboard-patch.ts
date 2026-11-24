// Shared dashboard patch semantics. The Go port is internal/observabilitygateway/insights_patch.go, and
// docs/design/insights/conformance/dashboard-patch.json is the fixture both implementations run. Keep the
// order of checks, the messages and the placement rules in step with that file.
//
// This module has no imports and uses only erasable TypeScript syntax, so the Node repair applier can load
// it directly (hack/insights-patch). It never throws on input and never mutates its arguments.

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }
export type JSONObject = { [key: string]: JSONValue }
export type WidgetEdit =
  | { op: "update"; id: string; patch: JSONObject }
  | { op: "add"; widget: JSONObject }
  | { op: "remove"; id: string }
export interface DashboardPatch {
  patch?: JSONObject
  widget_edits?: WidgetEdit[]
}
export interface GridBox {
  x: number
  y: number
  w: number
  h: number
}
export interface Placement {
  id: string
  layout: GridBox
  /** Set only when the requested rectangle overlapped a widget and the widget moved. */
  requested?: GridBox
}
export interface PatchError {
  code: "invalid_argument" | "not_found"
  reason: "input" | "immutable" | "limit" | "duplicate" | "missing" | "exists" | "unchanged" | "document"
  message: string
  editIndex?: number
  widgetId?: string
}
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
export interface WidgetChange {
  id: string
  title?: string
  kind: "added" | "removed" | "changed" | "moved"
  diff: JSONDiff
}
export interface DocumentChanges {
  dashboard: JSONDiff
  widgets: WidgetChange[]
}
export interface DashboardPatchResult {
  document: JSONObject | null
  placements: Placement[]
  changes: DocumentChanges | null
  error: PatchError | null
}

export const WIDGET_EDIT_LIMIT = 48
export const MAX_DIFF_CHANGES = 200
export const DOCUMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

const PATCH_BYTES = 256 * 1024
const PATCH_DEPTH = 32
const GRID_COLUMNS = 12
const MAX_GRID_ROW = 1000
const MAX_GRID_HEIGHT = 12
const TOP_LEVEL_FIELDS = ["patch", "widget_edits", "id", "etag", "message"]
const OPERATION_FIELDS: Record<string, string[]> = {
  update: ["op", "id", "patch"],
  add: ["op", "widget"],
  remove: ["op", "id"],
}
const IMMUTABLE_DOCUMENT_FIELDS = ["id", "schemaVersion", "widgets"]

function isObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function fail(code: PatchError["code"], reason: PatchError["reason"], message: string, extra?: { editIndex?: number; widgetId?: string }): PatchError {
  return { code, reason, message, ...extra }
}

function invalid(reason: PatchError["reason"], message: string, extra?: { editIndex?: number; widgetId?: string }): PatchError {
  return fail("invalid_argument", reason, message, extra)
}

function tooDeep(value: unknown, depth = 0): boolean {
  if (depth > PATCH_DEPTH) return true
  if (Array.isArray(value)) return value.some((item) => tooDeep(item, depth + 1))
  if (isObject(value)) return Object.values(value).some((item) => tooDeep(item, depth + 1))
  return false
}

function byteLength(value: unknown): number | null {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : new TextEncoder().encode(json).byteLength
  } catch {
    return null
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
}

/** Sets an own property, so a key such as "__proto__" is a plain field as it is in Go, never the prototype. */
function setField(target: JSONObject, key: string, value: JSONValue) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** RFC 7386 JSON Merge Patch for objects: null deletes, objects merge, every other value replaces. */
export function mergePatch(current: JSONValue | undefined, patch: JSONObject): JSONObject {
  const merged: JSONObject = isObject(current) ? { ...current } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else if (isObject(value)) setField(merged, key, mergePatch(Object.hasOwn(merged, key) ? merged[key] : undefined, value))
    else setField(merged, key, structuredClone(value))
  }
  return merged
}

function validateMergePatch(patch: unknown, forbidden: string[]): PatchError | null {
  if (!isObject(patch) || Object.keys(patch).length === 0) return invalid("input", "patch must be a nonempty JSON object")
  for (const field of forbidden) if (Object.hasOwn(patch, field)) return invalid("immutable", `patch cannot change ${field}`)
  return null
}

function validateWidgetEditShape(edits: unknown): PatchError | null {
  if (!Array.isArray(edits) || edits.length === 0) return invalid("input", "widget_edits must be a nonempty array")
  for (const operation of edits) {
    if (!isObject(operation)) return invalid("input", "invalid widget edit fields")
    // Go reads a missing op as an error and a null op as "", which no operation allows.
    if (!Object.hasOwn(operation, "op")) return invalid("input", "widget edit requires an operation")
    const allowed = operation.op === null ? undefined : OPERATION_FIELDS[operation.op as string]
    if (!allowed || Object.keys(operation).some((key) => !allowed.includes(key)))
      return invalid("input", "invalid fields for widget operation")
  }
  return null
}

function validateWidgetEdit(edit: WidgetEdit): { id: string } | PatchError {
  if (edit.op === "update") {
    if (typeof edit.id !== "string" || !DOCUMENT_ID_PATTERN.test(edit.id)) return invalid("input", "widget update requires a valid id and patch only")
    const patchError = validateMergePatch(edit.patch, ["id"])
    return patchError ?? { id: edit.id }
  }
  if (edit.op === "add") {
    const widget = isObject(edit.widget) ? edit.widget : undefined
    const id = widget?.id
    if (typeof id !== "string" || !DOCUMENT_ID_PATTERN.test(id)) return invalid("input", "widget add requires a widget with a valid id")
    return { id }
  }
  if (edit.op === "remove") {
    if (typeof edit.id !== "string" || !DOCUMENT_ID_PATTERN.test(edit.id)) return invalid("input", "widget remove requires a valid id only")
    return { id: edit.id }
  }
  return invalid("input", "widget operation must be update, add or remove")
}

const stringOrNull = (value: unknown) => value === null || typeof value === "string"

/**
 * Go decodes the arguments into typed fields before it checks them, so a member of the wrong type fails as
 * "invalid patch arguments". Go matches struct fields without regard to case, so the edit check does too.
 */
function decodesLikeGo(input: JSONObject): boolean {
  for (const key of ["id", "etag", "message"]) if (Object.hasOwn(input, key) && !stringOrNull(input[key])) return false
  const edits = input.widget_edits
  if (edits === undefined || edits === null) return true
  if (!Array.isArray(edits)) return false
  return edits.every(
    (edit) =>
      edit === null ||
      (isObject(edit) && Object.entries(edit).every(([key, value]) => !["op", "id"].includes(key.toLowerCase()) || stringOrNull(value))),
  )
}

/** Checks patch arguments exactly as the Go handler does, before any document is read. */
export function validateDashboardPatch(input: unknown): { value: DashboardPatch; error: null } | { value: null; error: PatchError } {
  const bad = (error: PatchError) => ({ value: null, error }) as const
  const size = byteLength(input)
  if (size === null || size > PATCH_BYTES || tooDeep(input))
    return bad(invalid("input", "patch arguments must be bounded JSON without duplicate keys"))
  if (!isObject(input) || Object.keys(input).some((key) => !TOP_LEVEL_FIELDS.includes(key)))
    return bad(invalid("input", "invalid patch argument fields"))
  if (!decodesLikeGo(input)) return bad(invalid("input", "invalid patch arguments"))
  if (input.widget_edits !== undefined) {
    const shape = validateWidgetEditShape(input.widget_edits)
    if (shape) return bad(shape)
  }
  if (input.patch === undefined && input.widget_edits === undefined)
    return bad(invalid("input", "provide a nonempty patch or widget edits"))
  if (input.patch !== undefined) {
    const patchError = validateMergePatch(input.patch, IMMUTABLE_DOCUMENT_FIELDS)
    if (patchError) return bad(patchError)
  }
  if (input.widget_edits !== undefined) {
    const edits = input.widget_edits as WidgetEdit[]
    if (edits.length > WIDGET_EDIT_LIMIT) return bad(invalid("limit", "at most 48 widget edits are allowed"))
    const seen = new Set<string>()
    for (const edit of edits) {
      const checked = validateWidgetEdit(edit)
      if ("code" in checked) return bad(checked)
      if (seen.has(checked.id)) return bad(invalid("duplicate", "widget edit targets must be unique"))
      seen.add(checked.id)
    }
  }
  return { value: { ...(input.patch !== undefined ? { patch: input.patch as JSONObject } : {}), ...(input.widget_edits !== undefined ? { widget_edits: input.widget_edits as WidgetEdit[] } : {}) }, error: null }
}

function gridOf(widget: JSONValue | undefined): GridBox | null {
  if (!isObject(widget) || !isObject(widget.layout)) return null
  const { x, y, w, h } = widget.layout
  if (![x, y, w, h].every((value) => Number.isInteger(value))) return null
  const box = { x, y, w, h } as GridBox
  const inBounds =
    box.x >= 0 && box.y >= 0 && box.y <= MAX_GRID_ROW && box.w >= 1 && box.x + box.w <= GRID_COLUMNS && box.h >= 1 && box.h <= MAX_GRID_HEIGHT
  return inBounds ? box : null
}

function overlaps(occupied: readonly GridBox[], box: GridBox): boolean {
  return occupied.some((other) => other.x < box.x + box.w && box.x < other.x + other.w && other.y < box.y + box.h && box.y < other.y + other.h)
}

function firstFreeSlot(occupied: readonly GridBox[], want: GridBox): GridBox {
  const bottom = occupied.reduce((max, box) => Math.max(max, box.y + box.h), 0)
  for (let y = 0; y <= bottom; y++)
    for (let x = 0; x + want.w <= GRID_COLUMNS; x++) {
      const candidate = { x, y, w: want.w, h: want.h }
      if (!overlaps(occupied, candidate)) return candidate
    }
  return { x: 0, y: bottom, w: want.w, h: want.h }
}

function editWidgets(
  document: JSONObject,
  edits: WidgetEdit[],
): { document: JSONObject; placements: Placement[] } | { error: PatchError } {
  if (!Array.isArray(document.widgets)) return { error: invalid("document", "dashboard widgets must be an array") }
  const widgets: JSONValue[] = [...document.widgets]
  // Removed slots are tracked apart from the values: a stored null widget stays, as it does in Go.
  const removed = new Set<number>()
  const indices = new Map<string, number>()
  for (let index = 0; index < widgets.length; index++) {
    const stored = widgets[index]
    // Go decodes each widget into {id string}: null and a null id read as "", any other non-object fails.
    if (stored !== null && (!isObject(stored) || !(stored.id === undefined || stringOrNull(stored.id))))
      return { error: invalid("document", "invalid stored widget") }
    indices.set(isObject(stored) && typeof stored.id === "string" ? stored.id : "", index)
  }
  // Updates and removes run first, in the order given, so every add is placed against the layout they leave.
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]
    if (edit.op === "add") continue
    const index = indices.get(edit.id)
    if (index === undefined) return { error: fail("not_found", "missing", "widget edit target was not found", { editIndex, widgetId: edit.id }) }
    if (edit.op === "remove") removed.add(index)
    else widgets[index] = mergePatch(widgets[index], edit.patch)
  }
  const placements: Placement[] = []
  for (let editIndex = 0; editIndex < edits.length; editIndex++) {
    const edit = edits[editIndex]
    if (edit.op !== "add") continue
    const widget = edit.widget
    const id = String(widget.id)
    if (indices.has(id)) return { error: invalid("exists", "cannot add a widget whose id already exists", { editIndex, widgetId: id }) }
    const want = gridOf(widget)
    if (!want) {
      widgets.push(structuredClone(widget))
      continue
    }
    const occupied = widgets.filter((_, index) => !removed.has(index)).map(gridOf).filter((box): box is GridBox => box !== null)
    if (!overlaps(occupied, want)) {
      placements.push({ id, layout: want })
      widgets.push(structuredClone(widget))
      continue
    }
    const placed = firstFreeSlot(occupied, want)
    const moved = structuredClone(widget)
    setField(moved, "layout", mergePatch(moved.layout, { x: placed.x, y: placed.y }))
    widgets.push(moved)
    placements.push({ id, layout: placed, requested: want })
  }
  const remaining = widgets.filter((_, index) => !removed.has(index))
  if (remaining.length > WIDGET_EDIT_LIMIT) return { error: invalid("limit", "dashboard may contain at most 48 widgets") }
  return { document: { ...document, widgets: remaining as JSONObject[] }, placements }
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

/** What a patch changes, for review: dashboard settings, then each widget by id. Unchanged widgets are omitted. */
export function documentChanges(before: JSONObject, after: JSONObject): DocumentChanges {
  const { widgets: beforeWidgets = [], ...beforeRest } = before
  const { widgets: afterWidgets = [], ...afterRest } = after
  const objects = (list: JSONValue) => (Array.isArray(list) ? list : []).filter(isObject)
  const previous = new Map<string, JSONObject>()
  for (const widget of objects(beforeWidgets)) if (!previous.has(String(widget.id))) previous.set(String(widget.id), widget)
  const widgets: WidgetChange[] = []
  const nextIds = new Set<string>()
  for (const widget of objects(afterWidgets)) {
    const id = String(widget.id)
    if (nextIds.has(id)) continue
    nextIds.add(id)
    const title = typeof widget.title === "string" ? widget.title : undefined
    const prior = previous.get(id)
    if (!prior) {
      widgets.push({ id, title, kind: "added", diff: diffJSON({}, widget) })
      continue
    }
    const diff = diffJSON(prior, widget)
    if (diff.totalChanges === 0) continue
    const onlyLayout = !diff.truncated && diff.changes.every((change) => /^layout(\.|\[|$)/.test(change.path))
    widgets.push({ id, title, kind: onlyLayout ? "moved" : "changed", diff })
  }
  for (const widget of previous.values()) {
    const id = String(widget.id)
    if (nextIds.has(id)) continue
    widgets.push({ id, title: typeof widget.title === "string" ? widget.title : undefined, kind: "removed", diff: diffJSON(widget, {}) })
  }
  return { dashboard: diffJSON(beforeRest, afterRest), widgets }
}

/** Applies a patch to a copy of the document. Returns the merged document, placements and changes, or the first error. */
export function applyDashboardPatch(document: JSONObject, input: unknown): DashboardPatchResult {
  const failed = (error: PatchError): DashboardPatchResult => ({ document: null, placements: [], changes: null, error })
  const checked = validateDashboardPatch(input)
  if (checked.error) return failed(checked.error)
  const { patch, widget_edits: edits } = checked.value
  let next: JSONObject = structuredClone(document)
  let placements: Placement[] = []
  if (patch) next = mergePatch(next, patch)
  if (edits) {
    const edited = editWidgets(next, edits)
    if ("error" in edited) return failed(edited.error)
    next = edited.document
    placements = edited.placements
  }
  const size = byteLength(next)
  if (size === null || size > PATCH_BYTES || tooDeep(next)) return failed(invalid("limit", "patched document exceeds its size or nesting limit"))
  if (sameValue(document, next)) return failed(invalid("unchanged", "patch must change the document"))
  return { document: next, placements, changes: documentChanges(document, next), error: null }
}

/** Reads a patch from a stored source: patch arguments, a patch_dashboard call, or a bare widget_edits array. Anything else is a document. */
export function readDashboardPatchSource(value: unknown): (DashboardPatch & { id?: string; etag?: string; message?: string }) | null {
  if (Array.isArray(value)) return { widget_edits: value as WidgetEdit[] }
  if (!isObject(value)) return null
  const source: unknown = value.name === "patch_dashboard" && isObject(value.arguments) ? value.arguments : value
  if (!isObject(source) || Object.hasOwn(source, "widgets") || (!Object.hasOwn(source, "widget_edits") && !Object.hasOwn(source, "patch"))) return null
  return source as DashboardPatch & { id?: string; etag?: string; message?: string }
}
