import assert from "node:assert/strict"

export function precisionFixtures(width) {
  const query = { schemaVersion: 1, id: `precision-${width}`, name: `Precision history ${width}`, providerId: "metrics", kind: "metrics", query: "sparkline_saved" }
  return { query, widgets: [
    { id: "host", title: "Parent health", type: "heatmap", providerId: "metrics", query: "parent_health", unit: "%", layout: { x: 0, y: 0, w: 12, h: 5 }, options: { tooltipView: { type: "stat", height: 120, unit: "ms", source: { type: "saved", ref: { id: query.id } } } } },
    { id: "precision-value", title: "Precision value", type: "stat", providerId: "metrics", query: "sparkline_saved", unit: "ms", layout: { x: 0, y: 5, w: 6, h: 4 } },
  ] }
}

/** Uses the caller's real Go service and deterministic provider fixture. */
export async function verifyPrecision({ page, width, api, panel, tooltip, showCell, saveBoard, shot, contained, centerTooltipChild }) {
  const evidence = []
  const stat = () => page.locator('[data-widget-id="precision-value"] [data-metric-value="1234.5678"]').first()
  const expected = (value, decimals) => new Intl.NumberFormat("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
  for (const decimals of [0, 2, 4]) {
    const before = (await api("dashboards/explorer-board")).document
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Parent health", exact: true }).click()
    await panel().getByRole("tab", { name: "Tooltips", exact: true }).click()
    await panel().getByLabel("Details decimal places", { exact: true }).fill(String(decimals))
    await panel().getByLabel("Tooltip decimal places", { exact: true }).fill(String(decimals))
    const control = panel().getByLabel("Tooltip decimal places", { exact: true })
    await control.scrollIntoViewIfNeeded(); await contained(control)
    await shot(`precision-control-${decimals}-${width}.png`)
    await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
    await page.getByRole("button", { name: "Edit Precision value", exact: true }).click()
    await panel().getByRole("tab", { name: "Style", exact: true }).click()
    await panel().getByLabel("Decimal places", { exact: true }).fill(String(decimals))
    await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
    await stat().waitFor()
    assert.equal((await stat().innerText()).replace(/\s/g, ""), `${expected(1234.5678, decimals)}ms`, "Single value preview must update before Save")
    assert.deepEqual((await api("dashboards/explorer-board")).document, before, "Precision previews must not persist before Save")
    await stat().scrollIntoViewIfNeeded(); await shot(`precision-single-value-${decimals}-${width}.png`)
    await saveBoard()
    await page.reload({ waitUntil: "networkidle" })
    const saved = (await api("dashboards/explorer-board")).document
    assert.equal(saved.widgets[0].options.decimals, decimals)
    assert.equal(saved.widgets[0].options.tooltipView.decimals, decimals)
    assert.equal(saved.widgets[1].options.decimals, decimals)
    await stat().waitFor()
    assert.equal((await stat().innerText()).replace(/\s/g, ""), `${expected(1234.5678, decimals)}ms`)
    await showCell()
    const reading = tooltip().locator('strong[data-metric-value="32"]').first()
    await reading.waitFor()
    assert.equal((await reading.innerText()).trim(), `${expected(32, decimals)}%`)
    const child = tooltip().locator('[data-tooltip-widget="stat"]')
    const childReading = child.locator('[data-metric-value="1234.5678"]')
    await childReading.waitFor()
    assert.equal((await childReading.innerText()).replace(/\s/g, ""), `${expected(1234.5678, decimals)}ms`)
    await centerTooltipChild(child); await contained(tooltip())
    await shot(`precision-tooltip-${decimals}-${width}.png`)
    await page.keyboard.press("Escape")
    await tooltip().waitFor({ state: "hidden" })
    evidence.push({ decimals, parentDetails: `${expected(32, decimals)}%`, singleValueAndChild: `${expected(1234.5678, decimals)} ms`, livePreview: true, savedAndReloaded: true, rawValue: 1234.5678 })
  }
  return { width, settings: evidence }
}
