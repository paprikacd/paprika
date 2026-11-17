import assert from "node:assert/strict"
import { selectGammaOption } from "./gamma-controls.mjs"
import { queryEditorValue } from "./query-editor.mjs"

// Exercise the live CodeMirror contenteditable and its keyboard contract against
// real Go metadata adapters. No hidden input or mocked language service is used.
export async function verifyProviderEditor({ page, width, theme, explorer, results, api, queryMode, detailsMode, queryRequests, providerRequests, until, shot, contained, fullyVisible }) {
  const start = queryRequests().length
  const scope = explorer()
  await queryMode("Code")
  const input = scope.getByRole("textbox", { name: /^PromQL query/ })
  const editor = scope.locator('[data-query-code-editor][data-language="promql"]')
  assert.equal(await input.getAttribute("contenteditable"), "true", "PromQL must use a real code editing surface")
  const syntax = () => scope.getByRole("status", { name: "Query syntax status", exact: true })
  const popup = () => page.locator(".cm-tooltip-autocomplete")
  const accepted = []

  async function complete(field, prefix, name, acceptKey = "Enter") {
    await field.fill(prefix)
    await field.press("End")
    await field.press("Control+Space")
    const option = popup().getByRole("option").filter({ has: page.locator(".cm-completionLabel").filter({ hasText: name }) }).first()
    await option.waitFor()
    const geometry = await contained(popup())
    if (prefix === "ra" || prefix === "{ resource.ser") await shot(`language-popup-${prefix === "ra" ? "promql" : "traceql"}-${theme.toLowerCase()}-${width}.png`)
    const count = await popup().getByRole("option").count()
    for (let index = 0; index <= count; index++) {
      const selected = popup().getByRole("option", { selected: true })
      if (await selected.count() && name.test(await selected.locator(".cm-completionLabel").innerText())) break
      await field.press("ArrowDown")
    }
    assert.match(await popup().getByRole("option", { selected: true }).locator(".cm-completionLabel").innerText(), name, "Completion must be keyboard selectable")
    await field.press(acceptKey)
    await popup().waitFor({ state: "hidden" })
    assert.equal(await field.evaluate(element => document.activeElement === element), true, "Accepting completion keeps editing focus")
    const value = await queryEditorValue(field)
    accepted.push({ prefix, value, acceptKey, geometry })
    return value
  }

  assert.match(await complete(input, "ra", /^rate\b/, "Tab"), /^rate\b/)
  assert.equal(await complete(input, "http_", /^http_requests_total\b/), "http_requests_total")
  assert.match(await complete(input, "http_requests_total{ser", /^service\b/), /\{service/)
  assert.match(await complete(input, 'http_requests_total{service="w', /^worker\b/), /service="worker/)
  assert.ok(providerRequests.some(request => request.path.endsWith("/label/__name__/values")), "Metric completion must come from the configured Prometheus provider")
  assert.ok(providerRequests.some(request => request.path.endsWith("/label/service/values")), "Value completion must request the current label's provider values")
  await shot(`language-completion-${theme.toLowerCase()}-${width}.png`)

  await input.fill("ra"); await input.press("Control+Space")
  await popup().getByRole("option").filter({ has: page.locator(".cm-completionLabel").filter({ hasText: /^rate\b/ }) }).first().waitFor()
  await input.press("Escape"); await popup().waitFor({ state: "hidden" })
  assert.equal(await input.evaluate(element => document.activeElement === element), true, "Escape dismisses suggestions without moving focus")
  await input.press("Tab")
  assert.equal(await input.evaluate(element => document.activeElement === element), false, "Tab with no completion must leave the editor without a focus trap")

  await input.fill("sum(rate(http_requests_total[5m])")
  await until(async () => /syntax issue/.test(await syntax().innerText()), "Malformed PromQL must display a syntax diagnostic")
  const malformedDiagnostic = await syntax().innerText()
  if (width >= 1000) await fullyVisible(syntax(), "PromQL syntax diagnostic")
  await input.fill('sum(rate(http_requests_total{service="api"}[5m]))')
  await until(async () => /Syntax checked/.test(await syntax().innerText()), "Corrected PromQL should clear the syntax diagnostic")
  const highlights = await editor.locator(".cm-line span").evaluateAll(elements => [...new Set(elements.map(element => getComputedStyle(element).color))])
  assert.ok(highlights.length >= 2, `A real language grammar should distinguish functions, strings and selectors: ${highlights}`)

  await detailsMode("Overview")
  const name = `Language editor ${width} ${theme}`
  await scope.getByLabel("Query name", { exact: true }).fill(name)
  await detailsMode("Parameters")
  await scope.getByRole("button", { name: "Add parameter", exact: true }).click()
  await scope.getByLabel("Parameter 1 name", { exact: true }).fill("service")
  await scope.getByLabel("Parameter 1 label", { exact: true }).fill("Service")
  assert.match(await complete(input, "http_requests_total{service={{ser", /^\{\{service\}\}/), /\{\{service\}\}/)
  const template = "sum(rate(http_requests_total{service={{service}}}[5m]))"
  await input.fill(template)
  await until(async () => /Syntax checked/.test(await syntax().innerText()), "A declared text parameter in a label selector must not produce a false grammar error")
  assert.equal(queryRequests().length, start, "Typing, completing, diagnostics and parameter editing must never execute the query")
  await scope.getByRole("button", { name: "Save query", exact: true }).click()
  await scope.getByText("Query saved.", { exact: true }).waitFor()
  const saved = (await api("saved-queries")).document.queries.find(query => query.name === name)
  assert.equal(saved.query, template, "Editor text must be saved exactly, preserving parameters")
  await results().getByLabel("Test value for service", { exact: true }).fill("worker")
  assert.equal(queryRequests().length, start, "Saving and typing preview values must still require explicit Run")
  await scope.getByRole("button", { name: "Run query", exact: true }).click()
  const resolved = 'sum(rate(http_requests_total{service="worker"}[5m]))'
  await until(() => queryRequests().at(-1)?.params.query === resolved, "Run must resolve the selected parameter and execute the exact editor expression")
  await results().getByRole("img", { name, exact: true }).waitFor()
  if (width >= 1000) await fullyVisible(syntax(), "PromQL syntax status while results are visible")
  await shot(`language-promql-${theme.toLowerCase()}-${width}.png`)

  await selectGammaOption(page, scope.getByRole("combobox", { name: "Explore data source", exact: true }), /Library traces/)
  const trace = scope.getByRole("textbox", { name: /^TraceQL query/ })
  await scope.locator('[data-query-code-editor][data-language="traceql"]').waitFor()
  assert.equal(await scope.getByRole("textbox", { name: /^PromQL query/ }).count(), 0, "Changing provider replaces the language mode")
  const beforeTrace = queryRequests().length
  assert.match(await complete(trace, "{ resource.ser", /^resource\.service\.name\b/), /resource\.service\.name/)
  assert.match(await complete(trace, '{ resource.service.name = "w', /^worker\b/), /"worker/)
  assert.ok(providerRequests.some(request => request.path === "/tempo/api/search/tags"), "TraceQL field completion must use the Tempo adapter")
  assert.ok(providerRequests.some(request => request.path === "/tempo/api/search/tag/service.name/values"), "TraceQL values must use the discovered provider label")
  const traceQuery = '{ resource.service.name = "worker" }'
  await trace.fill(traceQuery)
  await until(async () => /Syntax checked/.test(await syntax().innerText()), "TraceQL syntax should be checked with the provider's grammar")
  assert.equal(queryRequests().length, beforeTrace, "TraceQL metadata completion and edits must not search traces")
  await scope.getByRole("button", { name: "Run query", exact: true }).click()
  await until(() => queryRequests().at(-1)?.params.q === traceQuery, "TraceQL Run must send the exact expression to Tempo")
  await results().getByText("saved-trace-service", { exact: true }).first().waitFor()
  await shot(`language-traceql-${theme.toLowerCase()}-${width}.png`)
  return { width, theme, accepted, malformedDiagnostic, syntaxHighlights: highlights, exactSavedTemplate: saved.query, resolved, traceQuery, explicitExecutionOnly: true, keyboardEscapeAndTab: true }
}
