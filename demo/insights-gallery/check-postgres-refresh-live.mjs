// Read-only end-to-end check for a new isolated gallery stack. The worker is
// expected to append at least one minute of edge history after startup.
import assert from "node:assert/strict"
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response.json()
}
const saved = (await api("/api/insights/saved-queries")).queries.find(item => item.id === "local-ab-edge-watch-risks")
assert.ok(saved, "The seeded Edge risk query must exist")
const now = Math.floor(Date.now() / 1000)
const request = async query => (await api("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "records", query, start: now - 3600, end: now + 120, step: 60 }) })).records
let clock
for (let attempt = 0; attempt < 30; attempt++) {
  clock = (await request("SELECT initial_at,through_at FROM gallery.synthetic_history_clock WHERE name='edge'")).rows[0]
  if (Date.parse(clock[1]) > Date.parse(clock[0])) break
  await new Promise(resolve => setTimeout(resolve, 3000))
}
assert.ok(clock && Date.parse(clock[1]) > Date.parse(clock[0]), "The in-container worker must append a later observation")
const max = (await request("SELECT max(observed_at) FROM gallery.edge_source_history" )).rows[0][0]
assert.ok(Date.parse(max) >= Date.parse(clock[1]), "The checkpoint must be backed by recorded source samples")
const frame = await request(saved.query.replaceAll("{{gateway}}", JSON.stringify("omega")))
const history = frame.columns.findIndex(column => column.key === "trend")
assert.ok(history >= 0 && frame.rows.length > 0)
assert.ok(frame.rows.every(row => Date.parse(JSON.parse(row[history]).at(-1).timestamp) >= Date.parse(clock[1])), "The user-facing saved query must expose the appended samples")
console.log("PASS live PostgreSQL worker appended synthetic samples visible through the saved query")
