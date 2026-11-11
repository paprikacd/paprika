import {test} from "node:test"
import assert from "node:assert/strict"
import {Window} from "happy-dom"
import {dashboardProbe} from "./dashboard-probe.mjs"

// happy-dom has no layout, so geometry is stubbed per element. Each box is
// {x, y, w, h} in viewport pixels; scroll and client sizes follow the DOM model.
function place(document, selector, box, metrics={}) {
  const element = document.querySelector(selector)
  if (!element) throw Error("missing fixture " + selector)
  const rectangle = {left: box.x, top: box.y, width: box.w, height: box.h, right: box.x + box.w, bottom: box.y + box.h}
  Object.defineProperty(element, "getBoundingClientRect", {value: () => rectangle, configurable: true})
  // A display:none box has no client rects. A collapsed box (height 0) still has one.
  Object.defineProperty(element, "getClientRects", {value: () => (box.hidden ? [] : [rectangle]), configurable: true})
  const size = {clientWidth: box.w, clientHeight: box.h, scrollWidth: box.w, scrollHeight: box.h, clientLeft: 0, clientTop: 0, ...metrics}
  for (const [key, value] of Object.entries(size)) Object.defineProperty(element, key, {value, configurable: true})
  return element
}

function page(markup, {innerWidth = 1000, documentWidth = 1000} = {}) {
  const window = new Window({width: innerWidth, height: 800})
  window.document.body.innerHTML = markup
  window.innerWidth = innerWidth
  Object.defineProperty(window.document.documentElement, "scrollWidth", {value: documentWidth, configurable: true})
  return window.document
}

const rulesOf = result => result.findings.map(finding => finding.ruleId + "@" + finding.widgetId + ":" + finding.severity)
const forRule = (result, ruleId) => result.findings.filter(finding => finding.ruleId === ruleId)

const tile = (id, inner, extra = "") => `<article data-widget-id="${id}" aria-label="${id}" ${extra}>${inner}</article>`

test("findings use the shared wire names and carry fixed text, with no pointer", () => {
  const document = page(tile("alerted", `<div role="alert" id="a">Query failed</div>`))
  place(document, "#a", {x: 0, y: 0, w: 200, h: 40})
  const result = dashboardProbe({document})
  assert.equal(result.findings.length, 1)
  const [finding] = result.findings
  assert.deepEqual(Object.keys(finding).sort(), ["fix", "message", "pointer", "ruleId", "severity", "source", "widgetId"])
  assert.equal(finding.source, "SOURCE_VISUAL")
  assert.equal(finding.pointer, "")
  assert.equal(finding.severity, "SEVERITY_ERROR")
  assert.equal(finding.widgetId, "alerted")
  assert.ok(!finding.message.includes("Query failed"), "dashboard text must never reach the message")
  assert.ok(Number.isInteger(result.probeMs) && result.probeMs >= 0)
  assert.equal(result.widgets, 1)
})

test("visual.widget-error: a shown alert or a source-unavailable state is an error, a hidden alert is not", () => {
  const shown = page(tile("broken", `<div role="alert" id="a">x</div>`))
  place(shown, "#a", {x: 0, y: 0, w: 120, h: 30})
  assert.deepEqual(rulesOf(dashboardProbe({document: shown})), ["visual.widget-error@broken:SEVERITY_ERROR"])

  const unavailable = page(tile("pending", `<div data-widget-state="source-unavailable" id="s">x</div>`))
  place(unavailable, "#s", {x: 0, y: 0, w: 120, h: 30})
  assert.deepEqual(rulesOf(dashboardProbe({document: unavailable})), ["visual.widget-error@pending:SEVERITY_ERROR"])

  const hidden = page(tile("quiet", `<div role="alert" id="a">x</div>`))
  place(hidden, "#a", {x: 0, y: 0, w: 0, h: 0, hidden: true})
  assert.deepEqual(rulesOf(dashboardProbe({document: hidden})), [])
})

test("visual.internal-scroll: an auto or scroll body whose content is taller than its box is a warning", () => {
  const scrolls = page(tile("body", `<div id="s" style="overflow-y: auto">rows</div>`))
  place(scrolls, "#s", {x: 0, y: 0, w: 200, h: 80}, {scrollHeight: 240})
  assert.deepEqual(rulesOf(dashboardProbe({document: scrolls})), ["visual.internal-scroll@body:SEVERITY_WARNING"])

  const collapsed = page(tile("collapsed", `<div id="s" style="overflow-y: auto">rows</div>`))
  place(collapsed, "#s", {x: 0, y: 0, w: 200, h: 0}, {scrollHeight: 90})
  assert.deepEqual(rulesOf(dashboardProbe({document: collapsed})), ["visual.internal-scroll@collapsed:SEVERITY_WARNING"],
    "a collapsed scroller still hides its content")

  const clipped = page(tile("clip", `<div id="s" style="overflow-y: hidden">rows</div>`))
  place(clipped, "#s", {x: 0, y: 0, w: 200, h: 80}, {scrollHeight: 240})
  assert.deepEqual(forRule(dashboardProbe({document: clipped}), "visual.internal-scroll"), [], "hidden overflow is clipping, not scrolling")

  const fits = page(tile("fits", `<div id="s" style="overflow-y: auto">rows</div>`))
  place(fits, "#s", {x: 0, y: 0, w: 200, h: 80}, {scrollHeight: 80})
  assert.deepEqual(forRule(dashboardProbe({document: fits}), "visual.internal-scroll"), [])
})

test("visual.clipped-text: a metric value cut by its clipper is an error, other text is a warning", () => {
  const stat = page(tile("kpi", `<div id="body" style="overflow: hidden"><div data-metric-value="1" id="v">101.23 <span>req/s</span></div></div>`))
  place(stat, "#body", {x: 0, y: 0, w: 200, h: 60})
  place(stat, "#v", {x: 10, y: 40, w: 180, h: 40})
  assert.deepEqual(rulesOf(dashboardProbe({document: stat})), ["visual.clipped-text@kpi:SEVERITY_ERROR"])

  const prose = page(tile("note", `<p id="p" style="overflow: hidden">A long description that runs out of the card.</p>`))
  place(prose, "#p", {x: 0, y: 0, w: 200, h: 30}, {scrollHeight: 90})
  assert.deepEqual(rulesOf(dashboardProbe({document: prose})), ["visual.clipped-text@note:SEVERITY_WARNING"])
})

test("visual.clipped-text: intentional ellipsis is accepted, except on metric values", () => {
  const ellipsis = page(tile("title", `<h3 id="h" style="overflow: hidden; text-overflow: ellipsis">A long title</h3>`))
  place(ellipsis, "#h", {x: 0, y: 0, w: 80, h: 20}, {scrollWidth: 260})
  assert.deepEqual(forRule(dashboardProbe({document: ellipsis}), "visual.clipped-text"), [])

  const reading = page(tile("reading", `<div id="b" style="overflow: hidden; text-overflow: ellipsis"><span data-metric-value="1" id="v">101.23 req per second long unit</span></div>`))
  place(reading, "#b", {x: 0, y: 0, w: 120, h: 40})
  place(reading, "#v", {x: 0, y: 0, w: 260, h: 40}, {scrollWidth: 260, clientWidth: 260})
  const [finding] = forRule(dashboardProbe({document: reading}), "visual.clipped-text")
  assert.equal(finding?.severity, "SEVERITY_ERROR", "stat values must never be ellipsised")
})

test("visual.clipped-text: visible overflow and visually hidden text are not clipped", () => {
  const visible = page(tile("open", `<div id="b"><span id="v">a long but unclipped line</span></div>`))
  place(visible, "#b", {x: 0, y: 0, w: 200, h: 30})
  place(visible, "#v", {x: 0, y: 0, w: 400, h: 30}, {scrollWidth: 400, clientWidth: 400})
  assert.deepEqual(forRule(dashboardProbe({document: visible}), "visual.clipped-text"), [], "no clipping ancestor, so nothing is cut")

  const srOnly = page(tile("sr", `<div id="s" style="overflow: hidden"><span id="t">Latest valid sample time</span></div>`))
  place(srOnly, "#s", {x: 0, y: 0, w: 1, h: 1}, {scrollWidth: 200})
  place(srOnly, "#t", {x: 0, y: 0, w: 200, h: 20})
  assert.deepEqual(forRule(dashboardProbe({document: srOnly}), "visual.clipped-text"), [], "a 1px visually hidden box is not clipped content")
})

test("visual.empty-plot: a chart reporting data with only axes drawn is a warning; a drawn path is not", () => {
  const empty = page(tile("flat", `<div data-series-count="1"><svg role="img" id="c"><line x1="0" x2="200"/><line y1="0" y2="100"/></svg></div>`))
  place(empty, "#c", {x: 0, y: 0, w: 220, h: 120})
  assert.deepEqual(rulesOf(dashboardProbe({document: empty})), ["visual.empty-plot@flat:SEVERITY_WARNING"])

  const drawn = page(tile("line", `<div data-series-count="1"><svg role="img" id="c"><path id="p" d="M1,4L80,60" stroke-width="1.8"/></svg></div>`))
  place(drawn, "#c", {x: 0, y: 0, w: 220, h: 120})
  place(drawn, "#p", {x: 10, y: 10, w: 150, h: 40})
  assert.deepEqual(forRule(dashboardProbe({document: drawn}), "visual.empty-plot"), [])

  const outside = page(tile("off", `<div data-series-count="1"><svg role="img" id="c"><path id="p" d="M1,4L80,60"/></svg></div>`))
  place(outside, "#c", {x: 0, y: 0, w: 220, h: 120})
  place(outside, "#p", {x: 10, y: 400, w: 150, h: 40})
  assert.deepEqual(rulesOf(dashboardProbe({document: outside})), ["visual.empty-plot@off:SEVERITY_WARNING"], "a series scaled outside the plot is not drawn")

  const noData = page(tile("none", `<svg role="img" id="c"><line x1="0" x2="200"/></svg>`))
  place(noData, "#c", {x: 0, y: 0, w: 220, h: 120})
  assert.deepEqual(forRule(dashboardProbe({document: noData}), "visual.empty-plot"), [], "a chart that reports no data is not an empty plot")
})

test("visual.page-overflow: document width beyond the viewport is an error with no widget id", () => {
  const wide = page(tile("wide", "<p>x</p>"), {innerWidth: 390, documentWidth: 430})
  const finding = dashboardProbe({document: wide}).findings.find(item => item.ruleId === "visual.page-overflow")
  assert.equal(finding?.severity, "SEVERITY_ERROR")
  assert.equal(finding?.widgetId, "")

  const fits = page(tile("narrow", "<p>x</p>"), {innerWidth: 390, documentWidth: 391})
  assert.deepEqual(forRule(dashboardProbe({document: fits}), "visual.page-overflow"), [], "one pixel of rounding is tolerated")
})

test("each rule reports at most once per widget", () => {
  const document = page(tile("many", `<div role="alert" id="a">x</div><div role="alert" id="b">y</div>`))
  place(document, "#a", {x: 0, y: 0, w: 100, h: 20})
  place(document, "#b", {x: 0, y: 30, w: 100, h: 20})
  assert.equal(forRule(dashboardProbe({document}), "visual.widget-error").length, 1)
})

test("the probe function is self-contained, so Playwright can serialize its source", () => {
  const source = dashboardProbe.toString()
  assert.ok(!/\brequire\(|\bimport\(/.test(source), "no module references inside the serialized body")
  assert.doesNotThrow(() => new Function("return " + source))
})
