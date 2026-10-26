import assert from "node:assert/strict"
import { selectGammaOption } from "./gamma-controls.mjs"

export function connectionQuery(width) {
  return { schemaVersion: 1, id: `connections-${width}`, name: `Connected request details ${width}`, providerId: "metrics", kind: "metrics",
    query: "connection_probe{service={{service}},tenant={{tenant}}} @ {{timestamp}} + {{value}}",
    parameters: [{ name: "service", type: "string" }, { name: "tenant", type: "string" }, { name: "timestamp", type: "number" }, { name: "value", type: "number" }] }
}

export async function verifyConnections({ page, width, query, api, panel, editHost, saveBoard, showCell, tooltip, queryRequests, until, shot, specialLabel }) {
  const before = (await api("dashboards/explorer-board")).document
  const requestsBefore = queryRequests().filter(item => item.params.query?.startsWith("connection_probe")).length
  await editHost()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Saved query")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip saved query", exact: true }), query.name)
  await panel().getByRole("button", { name: /^Available graph data/ }).click()
  const available = panel().getByRole("region", { name: /^Available graph data/ })
  assert.match(await available.innerText(), /service/)
  assert.match(await available.innerText(), /worker/)
  await panel().getByRole("button", { name: "Connect 4 matching parameters", exact: true }).click()
  assert.equal(await panel().getByRole("combobox", { name: "Observation label for service", exact: true }).inputValue(), "service")
  assert.equal(await panel().getByRole("combobox", { name: "Dashboard variable for tenant", exact: true }).innerText(), "tenant")
  await panel().getByRole("combobox", { name: "Observation label for service", exact: true }).scrollIntoViewIfNeeded()
  await shot(`query-connections-${width}.png`)
  assert.deepEqual((await api("dashboards/explorer-board")).document, before)
  assert.equal(queryRequests().filter(item => item.params.query?.startsWith("connection_probe")).length, requestsBefore, "Authoring connections must not execute a tooltip query")
  await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
  await saveBoard(); await page.reload({ waitUntil: "networkidle" })
  const saved = (await api("dashboards/explorer-board")).document.widgets[0].options.tooltipView.source.ref
  assert.deepEqual(saved.bindings, [
    { parameter: "service", source: "label", label: "service" },
    { parameter: "tenant", source: "variable", variable: "tenant" },
    { parameter: "timestamp", source: "field", field: "timestamp" },
    { parameter: "value", source: "field", field: "value" },
  ])
  await showCell()
  await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="123.5"]').waitFor()
  await until(() => queryRequests().some(item => item.params.query?.startsWith("connection_probe")), "Connected tooltip did not query")
  const executed = queryRequests().findLast(item => item.params.query?.startsWith("connection_probe")).params.query
  assert.ok(executed.includes(`service=${JSON.stringify(specialLabel)},tenant="ops"`), executed)
  assert.match(executed, / @ \d+\.75 \+ 32$/)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  await editHost()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Provider query")
  await panel().getByRole("textbox", { name: "Tooltip PromQL query", exact: true }).fill("connected_provider{service={{service}}} @ {{timestamp}} + {{value}}")
  await panel().getByRole("button", { name: "Connect 3 matching fields", exact: true }).click()
  assert.equal(await panel().getByRole("combobox", { name: "Tooltip mapping 1 hovered label", exact: true }).inputValue(), "service")
  await panel().getByRole("button", { name: "Close widget editor", exact: true }).click(); await saveBoard()
  const providerBindings = (await api("dashboards/explorer-board")).document.widgets[0].options.tooltipView.source.bindings
  assert.deepEqual(providerBindings, [{ variable: "service", label: "service" }, { variable: "timestamp", field: "timestamp" }, { variable: "value", field: "value" }])
  return { width, savedBindings: saved.bindings, executed, providerBindings, authoringDoesNotQuery: true, persistedAfterSave: true }
}
