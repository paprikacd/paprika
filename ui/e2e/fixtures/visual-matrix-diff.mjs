// Pure comparison of visual-matrix renders against the committed baseline, and the report
// printed when it fails. No browser, so these rules are unit-tested in
// visual-matrix-diff.test.mjs.
//
// A render is { findings: string[], page: { overflowPx }, widgets: { [id]: { box, state } } }.
// box is [x, y, w, h] in CSS pixels relative to the dashboard canvas element, not the page, so
// a header that wraps differently on another platform does not move every tile.
// Findings are "ruleId@widgetId:SEVERITY" strings; widgetId "(page)" marks page-level findings.

export const overflowTolerancePx = 1

const count = values => values.reduce((totals, value) => totals.set(value, (totals.get(value) ?? 0) + 1), new Map())

// Multiset difference: entries of `from` that `minus` does not account for.
function difference(from, minus) {
  const remaining = count(minus), extra = []
  for (const value of from) {
    if (remaining.get(value) > 0) remaining.set(value, remaining.get(value) - 1)
    else extra.push(value)
  }
  return extra
}

const signed = value => (value > 0 ? `+${value}` : `${value}`)
const shiftText = ([dx, dy]) => `(dx ${signed(dx)}px, dy ${signed(dy)}px)`
const overlapsX = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2]

// Position and size changes per widget. Positions are judged against the tile above each
// widget, so a cascade (every tile below one change moving by the same amount) is one line,
// and a uniform shift of the whole grid is reported once.
function layoutLines(expected, actual, tolerancePx) {
  const ids = Object.keys(expected.widgets).filter(id => id in actual.widgets)
  const delta = id => {
    const before = expected.widgets[id].box, after = actual.widgets[id].box
    return [after[0] - before[0], after[1] - before[1], after[2] - before[2], after[3] - before[3]]
  }
  const lines = []
  // Tiles resized by the same amount are one line, so a grid that narrows reads as one change.
  const resized = new Map()
  for (const id of ids) {
    const [, , dw, dh] = delta(id)
    if (Math.max(Math.abs(dw), Math.abs(dh)) <= tolerancePx) continue
    const key = `${dw},${dh}`
    if (!resized.has(key)) resized.set(key, [])
    resized.get(key).push(id)
  }
  for (const [key, members] of resized) {
    const [dw, dh] = key.split(",").map(Number)
    if (members.length === 1) {
      const [, , w, h] = expected.widgets[members[0]].box
      const [, , w2, h2] = actual.widgets[members[0]].box
      lines.push(`~ widget "${members[0]}" resized ${w}x${h} -> ${w2}x${h2}`)
    } else {
      const names = members.slice(0, 5).map(id => `"${id}"`).join(", ")
      const more = members.length > 5 ? `, +${members.length - 5} more` : ""
      lines.push(`~ ${members.length} widgets resized (dw ${signed(dw)}px, dh ${signed(dh)}px): ${names}${more}`)
    }
  }
  const moving = ids.filter(id => delta(id).slice(0, 2).some(value => Math.abs(value) > tolerancePx))
  if (ids.length >= 2 && moving.length === ids.length) {
    const [dx, dy] = delta(ids[0])
    const uniform = ids.every(id => delta(id)[0] === dx && delta(id)[1] === dy)
    if (uniform) {
      lines.push(`~ all ${ids.length} widgets moved together ${shiftText([dx, dy])}`)
      return lines
    }
  }
  const moves = new Map()
  const order = [...ids].sort((a, b) => expected.widgets[a].box[1] - expected.widgets[b].box[1] || expected.widgets[a].box[0] - expected.widgets[b].box[0])
  for (const id of order) {
    const box = expected.widgets[id].box
    let above = null
    for (const other of order) {
      if (other === id) continue
      const candidate = expected.widgets[other].box
      if (candidate[1] + candidate[3] > box[1] + tolerancePx || !overlapsX(candidate, box)) continue
      if (above === null || candidate[1] + candidate[3] > expected.widgets[above].box[1] + expected.widgets[above].box[3]) above = other
    }
    const reference = above === null ? [0, 0] : delta(above)
    const relative = [delta(id)[0] - reference[0], delta(id)[1] - reference[1]]
    if (Math.max(Math.abs(relative[0]), Math.abs(relative[1])) > tolerancePx) {
      const group = `${above === null ? "canvas" : "above"}|${relative[0]},${relative[1]}`
      if (!moves.has(group)) moves.set(group, { relative, above: above !== null, members: [] })
      moves.get(group).members.push({ id, above })
    }
  }
  // Tiles moved by the same amount relative to the same reference are one line.
  for (const { relative, above, members } of moves.values()) {
    if (members.length === 1) {
      const where = above ? `relative to the tile above it "${members[0].above}"` : "relative to the canvas"
      lines.push(`~ widget "${members[0].id}" moved ${shiftText(relative)} ${where}`)
    } else {
      const names = members.slice(0, 5).map(member => `"${member.id}"`).join(", ")
      const more = members.length > 5 ? `, +${members.length - 5} more` : ""
      const where = above ? "relative to the tile above each" : "relative to the canvas"
      lines.push(`~ ${members.length} widgets moved ${shiftText(relative)} ${where}: ${names}${more}`)
    }
  }
  return lines
}

/** Returns the readable problems for one render, or [] when it matches its baseline. */
export function compareRender(expected, actual, tolerancePx) {
  const lines = []
  for (const finding of difference(actual.findings, expected.findings)) lines.push(`+ finding ${finding}`)
  for (const finding of difference(expected.findings, actual.findings)) lines.push(`- finding ${finding} (no longer reported)`)

  const overflowDelta = actual.page.overflowPx - expected.page.overflowPx
  if (Math.abs(overflowDelta) > overflowTolerancePx) {
    lines.push(`${overflowDelta > 0 ? "+" : "-"} page scroll overflow ${expected.page.overflowPx}px -> ${actual.page.overflowPx}px`)
  }

  for (const id of Object.keys(actual.widgets).filter(id => !(id in expected.widgets))) lines.push(`+ widget "${id}" added`)
  for (const id of Object.keys(expected.widgets).filter(id => !(id in actual.widgets))) lines.push(`- widget "${id}" removed`)
  lines.push(...layoutLines(expected, actual, tolerancePx))
  for (const id of Object.keys(expected.widgets).filter(id => id in actual.widgets)) {
    const before = expected.widgets[id].state, after = actual.widgets[id].state
    if (before !== after) lines.push(`~ widget "${id}" state ${before} -> ${after}`)
  }
  return lines
}

/** Compares every render key. Returns [{ key, lines }] for each render that differs. */
export function compareMatrix(baseline, current, tolerancePx = baseline.tolerancePx) {
  const keys = [...new Set([...Object.keys(baseline.renders), ...Object.keys(current.renders)])].sort()
  const problems = []
  for (const key of keys) {
    const expected = baseline.renders[key], actual = current.renders[key]
    if (!expected) problems.push({ key, lines: ["render is not in the baseline"] })
    else if (!actual) problems.push({ key, lines: ["render is in the baseline but was not captured"] })
    else {
      const lines = compareRender(expected, actual, tolerancePx)
      if (lines.length) problems.push({ key, lines })
    }
  }
  return problems
}

const themePattern = /\/(light|dark)\//

/**
 * The console summary (capped) and the full diff. The summary merges light and dark when they
 * differ identically, keeps about maxLines lines per render and shows at most maxRenders
 * renders. The full text keeps every line and is written to diff.txt.
 */
export function formatReport(problems, { renderCount, baselinePath, diffPath, maxLines = 10, maxRenders = 25 }) {
  const heading = `Visual matrix changed in ${problems.length} of ${renderCount} renders (baseline ${baselinePath}).`
  const legend = "  + gained   - lost   ~ moved, resized or changed"
  const footer = `Full diff: ${diffPath}. If the change is intended, review it, then rewrite the baseline with --update.`

  const full = problems.map(({ key, lines }) => [key, ...lines.map(line => `  ${line}`)].join("\n")).join("\n\n")

  const groups = new Map()
  for (const problem of problems) {
    const group = problem.key.replace(themePattern, "/{theme}/")
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(problem)
  }
  const entries = []
  for (const [group, members] of groups) {
    const identical = members.length === 2 && members.every(member => member.key.match(themePattern)) &&
      JSON.stringify(members[0].lines) === JSON.stringify(members[1].lines)
    if (identical) entries.push({ label: group.replace("{theme}", "light+dark"), lines: members[0].lines })
    else for (const member of members) entries.push({ label: member.key, lines: member.lines })
  }
  entries.sort((a, b) => a.label.localeCompare(b.label))

  const blocks = entries.slice(0, maxRenders).map(({ label, lines }) => {
    const shown = lines.slice(0, maxLines).map(line => `  ${line}`)
    if (lines.length > maxLines) shown.push(`  ... ${lines.length - maxLines} more lines in ${diffPath}`)
    return [label, ...shown].join("\n")
  })
  if (entries.length > maxRenders) blocks.push(`... ${entries.length - maxRenders} more renders in ${diffPath}`)

  return { summary: [heading, legend, "", blocks.join("\n\n"), "", footer].join("\n"), full: [heading, "", full].join("\n") }
}

/** Baseline text with one line per widget, so a change to one tile is one diff line. */
export function serializeBaseline(document) {
  const widgetLine = ([id, widget]) => `        ${JSON.stringify(id)}: ${JSON.stringify({ box: widget.box, state: widget.state })}`
  const renders = Object.keys(document.renders).sort().map(key => {
    const render = document.renders[key]
    const widgets = Object.entries(render.widgets).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return [
      `    ${JSON.stringify(key)}: {`,
      `      "findings": ${JSON.stringify(render.findings)},`,
      `      "page": ${JSON.stringify(render.page)},`,
      `      "widgets": {`,
      widgets.map(widgetLine).join(",\n"),
      "      }",
      "    }",
    ].join("\n")
  })
  return [
    "{",
    `  "schema": ${document.schema},`,
    `  "anchor": ${JSON.stringify(document.anchor)},`,
    `  "tolerancePx": ${document.tolerancePx},`,
    `  "viewportHeight": ${document.viewportHeight},`,
    `  "renders": {`,
    renders.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n")
}

/** Renders whose findings or widget states include an error, which --update refuses by default. */
export function errorRenders(document) {
  return Object.entries(document.renders)
    .filter(([, render]) => render.findings.some(finding => finding.endsWith(":ERROR")) ||
      Object.values(render.widgets).some(widget => widget.state === "error"))
    .map(([key]) => key)
}
