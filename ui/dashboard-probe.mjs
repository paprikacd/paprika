// DOM probe for rendered Insights dashboards. The render worker runs it in the page
// after every tile is ready, with page.evaluate(dashboardProbe, options). Playwright
// serializes only this function's source, so every helper lives inside the body and
// the function uses no imports or module state. Tests call it directly with a
// happy-dom document, passed as options.document.
//
// Findings use the shared CheckFinding wire names (SEVERITY_*, SOURCE_VISUAL), and
// messages and fixes are fixed text, never dashboard content. Each rule reports at
// most one finding per widget, and the page-level rule reports one with widgetId "".
//
// Rules (conditions are exact; "shown" means a box wider and taller than 1px, so
// visually hidden text and the contents of a closed <details> are ignored; visually
// hidden means a box no wider and no taller than 1px, or a clip-path):
//   visual.widget-error     ERROR   a shown [role="alert"] or
//                                   [data-widget-state="source-unavailable"] in the tile.
//   visual.page-overflow    ERROR   document scrollWidth > window innerWidth + 1.
//   visual.clipped-text     ERROR   for metric values and units, WARNING otherwise. An HTML
//                                   element with its own non-blank text, shown, whose
//                                   content (its own overflow, or its box crossing an
//                                   edge) extends past the inner edge of its nearest
//                                   ancestor-or-self, within the tile, with overflow
//                                   hidden or clip on that axis. Elements whose clipper
//                                   has text-overflow:ellipsis are intentional, except
//                                   metric values and units (any [data-metric-value]).
//   visual.internal-scroll  WARNING an HTML element in the tile with overflow-y auto or
//                                   scroll, laid out (any client rect, so a collapsed
//                                   scroller counts), and scrollHeight > clientHeight + 1.
//                                   Intentional keyboard-scrollable regions also match.
//   visual.empty-plot       WARNING a shown svg[role=img|group] of at least 40x40 in a
//                                   tile that reports data (a [data-series-count] above
//                                   zero, a [data-legend-value], or [data-metric-value]),
//                                   with no alert, busy or [data-widget-state] marker in the
//                                   tile, and that has no drawn data mark: a path[d] with a box, or
//                                   a rect or circle with width and height, whose box meets the
//                                   chart's box. Axis and grid <line> elements are not data.
export function dashboardProbe(options = {}) {
  const doc = options.document ?? globalThis.document
  const view = doc.defaultView ?? globalThis
  const now = () => (view.performance ?? globalThis.performance).now()
  const started = now()
  const HTML = "http://www.w3.org/1999/xhtml"
  const findings = []
  const rect = el => el.getBoundingClientRect()
  const shown = el => { const r = rect(el); return r.width > 1 && r.height > 1 }
  // Laid out at all (a closed <details> body or display:none has no client rects). A collapsed box still counts.
  const laidOut = el => el.getClientRects().length > 0
  const styleOf = el => view.getComputedStyle(el)
  // Engines expand the overflow shorthand into both axes; fall back to it for any that do not.
  const overflowAxis = (el, axis) => { const style = styleOf(el); return style[axis] || style.overflow }
  const clipsX = el => /^(hidden|clip)$/.test(overflowAxis(el, "overflowX"))
  const clipsY = el => /^(hidden|clip)$/.test(overflowAxis(el, "overflowY"))
  const finding = (ruleId, severity, widgetId, message, fix) => findings.push({ ruleId, severity, source: "SOURCE_VISUAL", widgetId, pointer: "", message, fix })
  const hasOwnText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() !== "")
  // A metric value and its unit are one text run (the unit sits inside [data-metric-value]).
  const metricValue = el => el.closest("[data-metric-value]") !== null
  // Visually hidden text (a 1px box or a clip-path, like the stat timestamp kept for AT) is not clipped content.
  const visuallyHidden = (el, tile) => {
    for (let node = el; node && node !== tile && tile.contains(node); node = node.parentElement) {
      if (node.namespaceURI !== HTML) continue
      const r = rect(node)
      const clip = styleOf(node).clipPath
      if ((r.width <= 1 && r.height <= 1) || (clip && clip !== "none")) return true
    }
    return false
  }

  // A selector matches the tile itself as well as its descendants.
  const within = (tile, selector) => (tile.matches(selector) ? tile : tile.querySelector(selector))

  const tiles = [...doc.querySelectorAll("[data-widget-id]")]
  for (const tile of tiles) {
    const id = tile.getAttribute("data-widget-id") ?? ""
    const elements = [...tile.querySelectorAll("*")].filter(el => el.namespaceURI === HTML)
    elements.unshift(tile)

    // visual.widget-error
    if ([...tile.querySelectorAll('[role="alert"], [data-widget-state="source-unavailable"]')].some(shown)) {
      finding("visual.widget-error", "SEVERITY_ERROR", id, "Widget shows an error instead of data.",
        "Fix the query, provider or source binding, then check again. Do not accept this render as a pass.")
    }

    // visual.internal-scroll
    let scrolling = 0
    for (const el of elements) {
      if (!(el.scrollHeight > el.clientHeight + 1) || !laidOut(el)) continue
      const overflowY = overflowAxis(el, "overflowY")
      if (overflowY === "auto" || overflowY === "scroll") scrolling++
    }
    if (scrolling > 0) {
      finding("visual.internal-scroll", "SEVERITY_WARNING", id, "Widget body scrolls vertically inside its tile.",
        "Increase layout.h, or remove extra description, stat bar or sparkline text so the widget fits without a scrollbar.")
    }

    // visual.clipped-text
    let clippedStat = 0, clippedOther = 0
    for (const el of elements) {
      if (!hasOwnText(el) || !shown(el)) continue
      let clipper = null
      for (let node = el; node && tile.contains(node); node = node.parentElement) {
        if (node.namespaceURI === HTML && (clipsX(node) || clipsY(node))) { clipper = node; break }
        if (node === tile) break
      }
      if (!clipper) continue
      const stat = metricValue(el)
      if (!stat && styleOf(clipper).textOverflow === "ellipsis") continue
      const inner = rect(clipper)
      const left = inner.left + clipper.clientLeft, top = inner.top + clipper.clientTop
      const right = left + clipper.clientWidth, bottom = top + clipper.clientHeight
      const box = rect(el)
      const contentRight = box.left + el.clientLeft + Math.max(el.scrollWidth, el.clientWidth)
      const contentBottom = box.top + el.clientTop + Math.max(el.scrollHeight, el.clientHeight)
      const cut = (clipsX(clipper) && contentRight > right + 1) || (clipsY(clipper) && contentBottom > bottom + 1)
      if (!cut || visuallyHidden(el, tile)) continue
      if (stat) clippedStat++
      else clippedOther++
    }
    if (clippedStat > 0) {
      finding("visual.clipped-text", "SEVERITY_ERROR", id, "A metric value or its unit is cut off.",
        "Widen the widget (layout.w), give the reading more height (layout.h), or shorten the unit. Stat values must never be ellipsised.")
    } else if (clippedOther > 0) {
      finding("visual.clipped-text", "SEVERITY_WARNING", id, "Text is cut off inside its widget.",
        "Widen or heighten the widget, shorten the text, or let it wrap.")
    }

    // visual.empty-plot
    const seriesCount = Number(within(tile, "[data-series-count]")?.getAttribute("data-series-count") ?? 0)
    const dataReported = seriesCount > 0 || within(tile, "[data-legend-value], [data-metric-value]") !== null
    if (dataReported && within(tile, '[role="alert"], [aria-busy="true"], [data-widget-state]') === null) {
      const charts = [...tile.querySelectorAll('svg[role="img"], svg[role="group"]')].filter(chart => {
        const r = rect(chart)
        return r.width >= 40 && r.height >= 40
      })
      // Series lines and areas are paths with a box, rects are bars or cells, and circles are points. Axis and grid
      // lines are <line> elements and are not data. A mark must also meet its chart's box: a series scaled entirely
      // outside the plot is placed outside the chart, so it is not drawn.
      const drawn = charts.some(chart => {
        const frame = rect(chart)
        return [...chart.querySelectorAll("path[d], rect, circle")].some(mark => {
          const r = rect(mark)
          const sized = mark.tagName === "path" ? r.width + r.height > 0 : r.width > 0 && r.height > 0
          return sized && r.right >= frame.left && r.left <= frame.right && r.bottom >= frame.top && r.top <= frame.bottom
        })
      })
      if (charts.length > 0 && !drawn) {
        finding("visual.empty-plot", "SEVERITY_WARNING", id, "Chart area has data but nothing is drawn.",
          "Check the line width, display mode and series options so the series is drawn.")
      }
    }
  }

  // visual.page-overflow
  if (doc.documentElement.scrollWidth > view.innerWidth + 1) {
    finding("visual.page-overflow", "SEVERITY_ERROR", "", "The page scrolls horizontally.",
      "Reduce the widget width, or wrap long text, so the page fits the viewport without horizontal scrolling.")
  }

  return { findings, widgets: tiles.length, probeMs: Math.round(now() - started) }
}
