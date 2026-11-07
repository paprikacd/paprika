import { z } from "zod"
import { parseRecordFrame } from "../record-data"
import type { RecordFrame } from "../schema"
import type { DrilldownContext } from "../drilldown"

const field = z.string().min(1).max(128)
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => utcDay(value) === value, "Use a valid UTC calendar date")

export const connectionMapConfig = z.strictObject({
  latitude: field.default("latitude"), longitude: field.default("longitude"), label: field.default("label"),
  value: field.optional(), status: field.optional(), showLocations: z.boolean().optional(), maxPoints: z.number().int().min(1).max(500).default(120),
  display: z.enum(["markers", "density"]).default("markers"), showGrid: z.boolean().optional(), showCoordinates: z.boolean().optional(),
})
export const pipelineTopologyConfig = z.strictObject({
  source: field.default("source"), target: field.default("target"), value: field.optional(), status: field.optional(),
  maxNodes: z.number().int().min(2).max(64).default(32), maxEdges: z.number().int().min(1).max(200).default(80),
})
export const incidentCalendarConfig = z.strictObject({
  date: field.default("date"), value: field.optional(), label: field.optional(), status: field.optional(),
  aggregation: z.enum(["count", "sum", "max"]).default("count"),
  colorMode: z.enum(["intensity", "thresholds"]).default("intensity"),
  months: z.number().int().min(1).max(6).default(3), endDate: isoDay.optional(),
}).refine(config => config.aggregation === "count" || !!config.value, "Sum and max aggregation require a value field")

export type ConnectionMapConfig = z.infer<typeof connectionMapConfig>
export type PipelineTopologyConfig = z.infer<typeof pipelineTopologyConfig>
export type IncidentCalendarConfig = z.infer<typeof incidentCalendarConfig>
type Row = RecordFrame["rows"][number]

function column(frame: RecordFrame, name: string, type?: "number") {
  const index = frame.columns.findIndex(item => item.key === name)
  if (index < 0) throw new Error(`The query result has no “${name}” column.`)
  if (type && frame.columns[index].type !== type) throw new Error(`The “${name}” field must be a numeric column.`)
  return index
}
function optionalColumn(frame: RecordFrame, name?: string, type?: "number") {
  return name ? column(frame, name, type) : -1
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const labelValue = (value: unknown) => value === null || value === undefined ? "" : String(value)

export function recordLabels(frame: RecordFrame, row: Row) {
  return Object.fromEntries(frame.columns.flatMap((item, index) => row[index] === null ? [] : [[item.key, String(row[index])]]))
}
function commonLabels(frame: RecordFrame, rows: Row[], exclude?: string) {
  if (!rows.length) return {}
  return Object.fromEntries(frame.columns.flatMap((item, index) => {
    const value = rows[0][index]
    return item.key !== exclude && value !== null && rows.every(row => row[index] === value) ? [[item.key, String(value)]] : []
  }))
}
export function statusTone(status: string): "positive" | "warning" | "critical" | "neutral" {
  const words = status.toLowerCase().split(/[^a-z]+/)
  if (words.some(word => ["error", "failed", "failure", "critical", "blocked", "unhealthy", "down"].includes(word))) return "critical"
  if (words.some(word => ["warning", "delayed", "stale", "retry", "degraded", "pending"].includes(word))) return "warning"
  if (words.some(word => ["ok", "healthy", "ready", "complete", "completed", "resolved", "allowed", "up"].includes(word))) return "positive"
  return "neutral"
}

export interface MapLocation {
  key: string; latitude: number; longitude: number; label: string; value: number | null; status: string
  x: number; y: number; context: DrilldownContext
}
export function buildConnectionMap(input: RecordFrame, config: ConnectionMapConfig) {
  const frame = parseRecordFrame(input)
  const latitude = column(frame, config.latitude, "number"), longitude = column(frame, config.longitude, "number")
  const label = column(frame, config.label), value = optionalColumn(frame, config.value, "number"), status = optionalColumn(frame, config.status)
  let invalid = 0
  const valid: MapLocation[] = []
  frame.rows.forEach((row, index) => {
    const lat = row[latitude], lon = row[longitude]
    if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) { invalid++; return }
    const name = labelValue(row[label]) || `${lat}°, ${lon}°`
    const numeric = finite(row[value]) ? row[value] as number : null
    valid.push({ key: String(index), latitude: lat, longitude: lon, label: name, value: numeric,
      status: labelValue(row[status]), x: (lon + 180) / 360, y: (90 - lat) / 180,
      context: { series: name, value: numeric, labels: recordLabels(frame, row) } })
  })
  return { frame, locations: valid.slice(0, config.maxPoints), invalid, omitted: Math.max(0, valid.length - config.maxPoints), valueUnit: value < 0 ? "" : frame.columns[value].unit ?? "" }
}

export interface PipelineEdge {
  key: string; source: string; target: string; value: number | null; observations: number; status: string; context: DrilldownContext
}
export interface PipelineNode {
  id: string; x: number; y: number; incoming: number; outgoing: number; cyclic: boolean; status: string
}

/** SCC condensation keeps cycles explicit while assigning deterministic acyclic layers. */
function layoutPipeline(ids: string[], edges: PipelineEdge[]) {
  const adjacency = new Map(ids.map(id => [id, edges.filter(edge => edge.source === id).map(edge => edge.target)]))
  const indexes = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>(), components: string[][] = []
  let nextIndex = 0
  const visit = (id: string) => {
    indexes.set(id, nextIndex); low.set(id, nextIndex++); stack.push(id); active.add(id)
    for (const target of adjacency.get(id) ?? []) {
      if (!indexes.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)) }
      else if (active.has(target)) low.set(id, Math.min(low.get(id)!, indexes.get(target)!))
    }
    if (low.get(id) !== indexes.get(id)) return
    const members: string[] = []
    let member: string
    do { member = stack.pop()!; active.delete(member); members.push(member) } while (member !== id)
    components.push(members.sort())
  }
  ids.forEach(id => { if (!indexes.has(id)) visit(id) })
  const componentById = new Map(components.flatMap((component, index) => component.map(id => [id, index] as const)))
  const parents = components.map(() => new Set<number>())
  edges.forEach(edge => { const source = componentById.get(edge.source)!, target = componentById.get(edge.target)!; if (source !== target) parents[target].add(source) })
  const ranks = new Map<number, number>()
  const rank = (index: number): number => {
    if (ranks.has(index)) return ranks.get(index)!
    const result = parents[index].size ? Math.max(...[...parents[index]].map(parent => rank(parent) + 1)) : 0
    ranks.set(index, result); return result
  }
  components.forEach((_, index) => rank(index))
  const groups = new Map<number, string[]>()
  ids.forEach(id => { const level = ranks.get(componentById.get(id)!)!; groups.set(level, [...groups.get(level) ?? [], id]) })
  const width = Math.max(440, (Math.max(0, ...groups.keys()) + 1) * 176 + 32)
  // Keep a small bottom inset after the last stage, without allocating an
  // additional empty row that turns a fitted diagram into a scrolling one.
  const height = (Math.max(1, ...[...groups.values()].map(group => group.length)) - 1) * 88 + 98
  const nodes: PipelineNode[] = ids.map(id => {
    const component = componentById.get(id)!, level = ranks.get(component)!, group = groups.get(level)!
    const incoming = edges.filter(edge => edge.target === id), outgoing = edges.filter(edge => edge.source === id)
    return { id, x: 24 + level * 176, y: 24 + group.indexOf(id) * 88, incoming: incoming.length, outgoing: outgoing.length,
      cyclic: components[component].length > 1 || outgoing.some(edge => edge.target === id),
      status: [...new Set([...incoming, ...outgoing].flatMap(edge => edge.status ? [edge.status] : []))].join(" · ") }
  })
  return { nodes, width, height, cycles: components.filter(component => component.length > 1 || edges.some(edge => edge.source === component[0] && edge.target === component[0])).length }
}

export function buildPipelineTopology(input: RecordFrame, config: PipelineTopologyConfig) {
  const frame = parseRecordFrame(input), source = column(frame, config.source), target = column(frame, config.target)
  const value = optionalColumn(frame, config.value, "number"), status = optionalColumn(frame, config.status)
  let invalid = 0
  const groups = new Map<string, {source: string; target: string; rows: Row[]}>()
  frame.rows.forEach(row => {
    const from = labelValue(row[source]).trim(), to = labelValue(row[target]).trim()
    if (!from || !to || from.length > 160 || to.length > 160) { invalid++; return }
    const key = JSON.stringify([from, to]), group = groups.get(key)
    if (group) group.rows.push(row)
    else groups.set(key, {source: from, target: to, rows: [row]})
  })
  const ids = [...new Set([...groups.values()].flatMap(group => [group.source, group.target]))].sort()
  const shownIds = ids.slice(0, config.maxNodes), allowed = new Set(shownIds)
  const allEdges: PipelineEdge[] = [...groups.entries()].map(([key, group]) => {
    const numbers = group.rows.map(row => row[value])
    const sum = numbers.every(finite) ? (numbers as number[]).reduce((total, item) => total + item, 0) : null
    const numeric = finite(sum) ? sum : null
    const observedStatus = [...new Set(group.rows.map(row => labelValue(row[status])).filter(Boolean))].join(" · ")
    const labels = { ...commonLabels(frame, group.rows, config.value), [config.source]: group.source, [config.target]: group.target }
    return { key, source: group.source, target: group.target, value: numeric, observations: group.rows.length, status: observedStatus,
      context: {series: `${group.source} → ${group.target}`, labels, value: numeric} }
  }).sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target))
  const edges = allEdges.filter(edge => allowed.has(edge.source) && allowed.has(edge.target)).slice(0, config.maxEdges)
  const visibleIds = shownIds.filter(id => edges.some(edge => edge.source === id || edge.target === id))
  return {frame, edges, ...layoutPipeline(visibleIds, edges), invalid, omittedNodes: ids.length - visibleIds.length,
    omittedEdges: allEdges.length - edges.length, merged: [...groups.values()].reduce((count, group) => count + group.rows.length - 1, 0),
    valueUnit: value < 0 ? "" : frame.columns[value].unit ?? ""}
}

/** ISO timestamps are converted to UTC. Bare dates must be real dates, never browser-normalized overflow. */
export function utcDay(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 8.64e15)) return
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value) && !z.iso.datetime({offset: true}).safeParse(value).success) return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return
  const day = date.toISOString().slice(0, 10)
  if (typeof value === "string" && value.length === 10 && value !== day) return
  return day
}

export interface CalendarDay {
  date: string; value: number | null; observations: number; labels: string[]; status: string; context: DrilldownContext
}
export interface CalendarMonth { key: string; label: string; offset: number; days: CalendarDay[] }

export function buildIncidentCalendar(input: RecordFrame, config: IncidentCalendarConfig) {
  const frame = parseRecordFrame(input), date = column(frame, config.date), value = optionalColumn(frame, config.value, "number")
  const label = optionalColumn(frame, config.label), status = optionalColumn(frame, config.status)
  const groups = new Map<string, Row[]>(); let invalid = 0
  frame.rows.forEach(row => {
    const key = utcDay(row[date]); if (!key) { invalid++; return }
    groups.set(key, [...groups.get(key) ?? [], row])
  })
  const end = config.endDate ?? [...groups.keys()].sort().at(-1)
  if (!end) return {frame, months: [] as CalendarMonth[], invalid, outside: 0, max: 0, valueUnit: ""}
  const endMonth = new Date(`${end.slice(0, 7)}-01T00:00:00Z`), start = new Date(endMonth)
  start.setUTCMonth(start.getUTCMonth() - config.months + 1)
  const lastDay = new Date(endMonth); lastDay.setUTCMonth(lastDay.getUTCMonth() + 1)
  let outside = 0
  groups.forEach((rows, day) => { const at = new Date(`${day}T00:00:00Z`); if (at < start || at >= lastDay) outside += rows.length })
  const months: CalendarMonth[] = []
  for (let offset = 0; offset < config.months; offset++) {
    const first = new Date(start); first.setUTCMonth(first.getUTCMonth() + offset)
    if (first.getUTCFullYear() < 1) continue
    const month = first.getUTCMonth(), cursor = new Date(first), days: CalendarDay[] = []
    while (cursor.getUTCMonth() === month) {
      const key = cursor.toISOString().slice(0, 10), rows = groups.get(key) ?? []
      const values = rows.map(row => row[value])
      let numeric: number | null = rows.length ? rows.length : null
      if (rows.length && config.aggregation !== "count") numeric = values.every(finite)
        ? config.aggregation === "sum" ? (values as number[]).reduce((sum, item) => sum + item, 0) : Math.max(...values as number[])
        : null
      if (numeric !== null && !Number.isFinite(numeric)) numeric = null
      days.push({date: key, value: numeric, observations: rows.length, labels: [...new Set(rows.map(row => labelValue(row[label])).filter(Boolean))],
        status: [...new Set(rows.map(row => labelValue(row[status])).filter(Boolean))].join(" · "),
        context: {series: key, value: numeric, labels: {...commonLabels(frame, rows, config.value), [config.date]: key, aggregation: config.aggregation, observations: String(rows.length)}}})
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    months.push({key: first.toISOString().slice(0, 7), label: first.toLocaleDateString("en", {month: "long", year: "numeric", timeZone: "UTC"}), offset: (first.getUTCDay() + 6) % 7, days})
  }
  return {frame, months, invalid, outside, max: Math.max(0, ...months.flatMap(month => month.days.flatMap(day => day.value === null ? [] : [Math.abs(day.value)]))),
    valueUnit: config.aggregation === "count" ? "observations" : value < 0 ? "" : frame.columns[value].unit ?? ""}
}
