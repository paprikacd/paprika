import { z } from "zod"
import { parseRecordFrame } from "../record-data"
import type { RecordFrame } from "../schema"
import { recordLabels } from "./operational-records-data"

const field = z.string().min(1).max(128)
export const geoHeatmapConfig = z.strictObject({
  mode: z.enum(["map", "grid"]).default("map"), latitude: field.default("latitude"), longitude: field.default("longitude"),
  label: field.default("label"), value: field.optional(), aggregation: z.enum(["count", "sum", "mean"]).default("count"),
  radius: z.number().int().min(8).max(36).default(18), gridColumns: z.number().int().min(8).max(48).default(20), maxRecords: z.number().int().min(1).max(500).default(200),
}).refine(value => value.aggregation === "count" || !!value.value, "A value field is required for sum and mean")
type Config = z.infer<typeof geoHeatmapConfig>
type Row = RecordFrame["rows"][number]
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

// Pointy-top axial coordinates, rounded in cube space so every position has
// one deterministic spatial bin. Coordinates are projected in a 720x360
// equirectangular plane, matching the land outline used by the map.
function cellFor(x: number, y: number, radius: number) {
  const q = (Math.sqrt(3) / 3 * x - y / 3) / radius, r = 2 / 3 * y / radius
  let a = Math.round(q), b = Math.round(r), c = Math.round(-q-r)
  const da = Math.abs(a-q), db = Math.abs(b-r), dc = Math.abs(c+q+r)
  if (da > db && da > dc) a = -b-c
  else if (db > dc) b = -a-c
  else c = -a-b
  return { key: `${a},${b}`, x: radius * Math.sqrt(3) * (a+b/2), y: radius * 1.5*b }
}

export function buildGeoHeatmap(input: RecordFrame, config: Config) {
  const frame = parseRecordFrame(input)
  const column = (name: string, numeric = false) => {
    const index = frame.columns.findIndex(item => item.key === name)
    if (index < 0) throw new Error(`The query result has no “${name}” column.`)
    if (numeric && frame.columns[index].type !== "number") throw new Error(`The “${name}” field must be a numeric column.`)
    return index
  }
  const label = column(config.label), value = config.value ? column(config.value, true) : -1
  const lat = config.mode === "map" ? column(config.latitude, true) : -1, lon = config.mode === "map" ? column(config.longitude, true) : -1
  const groups = new Map<string, { x: number; y: number; rows: Row[] }>()
  let invalid = 0
  frame.rows.slice(0, config.maxRecords).forEach((row, index) => {
    let tile: { key: string; x: number; y: number }
    if (config.mode === "map") {
      const latitude = row[lat], longitude = row[lon]
      if (!finite(latitude) || !finite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) { invalid++; return }
      tile = cellFor((longitude + 180) * 2, (90 - latitude) * 2, config.radius)
    } else {
      const step = 684 / config.gridColumns, radius = step / Math.sqrt(3)
      const rowIndex = Math.floor(index / config.gridColumns), col = index % config.gridColumns
      // Reserve space around the first tile for the visible keyboard focus ring.
      tile = { key: String(index), x: step / 2 + 5 + col * step + (rowIndex % 2) * step / 2, y: radius + 5 + rowIndex * radius * 1.5 }
    }
    const group = groups.get(tile.key)
    if (group) group.rows.push(row)
    else groups.set(tile.key, { x: tile.x, y: tile.y, rows: [row] })
  })
  const cells = [...groups.entries()].map(([key, group]) => {
    const nums = group.rows.map(row => row[value]).filter(finite), missing = value < 0 ? 0 : group.rows.length - nums.length
    // A partial sum/mean must not be labelled as the complete aggregation.
    const aggregated = config.aggregation === "count" ? group.rows.length : !missing && nums.length ?
      config.aggregation === "sum" ? nums.reduce((a,b) => a+b, 0) : nums.reduce((a,b) => a+b, 0) / nums.length : null
    const number = finite(aggregated) ? aggregated : null
    const name = group.rows.length === 1 ? String(group.rows[0][label] ?? "Observation") : `${group.rows.length} observations`
    const first = recordLabels(frame, group.rows[0])
    const labels = Object.fromEntries(Object.entries(first).filter(([key, value]) => group.rows.every(row => recordLabels(frame, row)[key] === value)))
    return { key, x: group.x, y: group.y, count: group.rows.length, value: number, missing, name, labels }
  })
  const numbers = cells.flatMap(cell => cell.value === null ? [] : [cell.value])
  return { frame, cells, invalid, omitted: Math.max(0, frame.rows.length-config.maxRecords), min: Math.min(...numbers), max: Math.max(...numbers), unit: value < 0 ? "" : frame.columns[value].unit ?? "" }
}
