// Validate synthetic map data through the real local records connector.
import assert from "node:assert/strict"
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const savedResponse = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(savedResponse.status, 200)
const queries = (await savedResponse.json()).queries
const saved = queries.find(query => query.id === "local-edge-geo-events")
assert.ok(saved, "The geographic saved query must exist")
const mapQuery = queries.find(query => query.id === "local-ab-edge-watch-locations")
const detailQuery = queries.find(query => query.id === "local-edge-location-detail")
assert.ok(mapQuery && detailQuery, "Map and selected-location saved queries must exist")
const end = Math.floor(Date.now() / 1000)
for (const cluster of ["omega", "delta"]) {
  const response = await fetch(new URL("/api/insights/query", origin), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "records", query: saved.query.replaceAll("{{gateway}}", JSON.stringify(cluster)), start: end - 3600, end, step: 60 }) })
  assert.equal(response.status, 200)
  const data = await response.json(), frame = data.records
  assert.ok(frame && !data.truncated && !frame.truncated, "The full recorded geographic set must fit the provider page")
  assert.equal(frame.rows.length, 288)
  const col = name => frame.columns.findIndex(column => column.key === name)
  const labels = frame.rows.map(row => row[col("label")])
  assert.equal(new Set(labels).size, labels.length)
  assert.equal(labels.filter(label => label.includes(" region sample ")).length, 192)
  for (const row of frame.rows) {
    assert.ok(Number.isFinite(row[col("latitude")]) && Math.abs(row[col("latitude")]) <= 90)
    assert.ok(Number.isFinite(row[col("longitude")]) && Math.abs(row[col("longitude")]) <= 180)
  }
  const centers = new Map([["Melbourne", [-37.81, 144.96]], ["Singapore", [1.35, 103.82]], ["Tokyo", [35.68, 139.69]], ["Sydney", [-33.87, 151.21]], ["Frankfurt", [50.11, 8.68]], ["London", [51.50, -.12]], ["Paris", [48.86, 2.35]], ["Virginia", [37.43, -78.65]], ["San Francisco", [37.77, -122.42]], ["Toronto", [43.65, -79.38]], ["São Paulo", [-23.55, -46.63]], ["Cape Town", [-33.92, 18.42]]])
  for (const row of frame.rows) {
    const match = /^(.*?) (region )?sample (\d+)$/.exec(row[col("label")])
    assert.ok(match && centers.has(match[1]), `Unexpected location label: ${row[col("label")]}`)
    const [lat, lon] = centers.get(match[1])
    assert.ok(Math.hypot(row[col("latitude")] - lat, row[col("longitude")] - lon) <= (match[2] ? 2.2 : .18), `${match[0]} must remain near its named center`)
  }
  const run = async (definition, substitutions) => {
    let query = definition.query
    for (const [name, replacement] of Object.entries(substitutions)) query = query.replaceAll(`{{${name}}}`, JSON.stringify(replacement))
    const reply = await fetch(new URL("/api/insights/query", origin), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: definition.providerId, kind: "records", query, start: end - 3600, end, step: 60 }) })
    assert.equal(reply.status, 200, `${definition.id}: ${await reply.clone().text()}`)
    return (await reply.json()).records
  }
  const map = await run(mapQuery, { gateway: cluster })
  const mapLabel = map.columns.findIndex(column => column.key === "label")
  assert.equal(map.rows.length, 432, "The map must include the original city observations and distributed land samples")
  assert.equal(map.rows.filter(row => String(row[mapLabel]).startsWith("Global land sample ")).length, 144)
  assert.equal(new Set(map.rows.map(row => row[mapLabel])).size, 432)
  for (const location of ["Global land sample 001", "Melbourne sample 1"]) {
    const detail = await run(detailQuery, { gateway: cluster, location })
    const detailLabel = detail.columns.findIndex(column => column.key === "label")
    assert.equal(detail.rows.length, 1, `${cluster}: ${location} must resolve to one recorded point`)
    assert.equal(detail.rows[0][detailLabel], location)
  }
  console.log(`PASS ${cluster}: ${frame.rows.length} distinct, bounded synthetic geographic observations`)
  console.log(`PASS ${cluster}: ${map.rows.length} map points; named and global sample details follow the selected cluster`)
}
