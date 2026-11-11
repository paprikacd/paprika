// Pure comparison of visual-matrix renders against the committed baseline. No browser,
// so the rules are unit-tested in visual-matrix-diff.test.mjs.
//
// A render record is { findings: string[], page: { overflowPx }, widgets: { [id]: { box: [x, y, w, h], state } } }.
// Findings are "ruleId@widgetId:SEVERITY" strings (widgetId "(page)" for page-level findings).

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

/** Returns the readable problems for one render, or [] when it matches its baseline. */
export function compareRender(expected, actual, tolerancePx) {
  const lines = []
  for (const finding of difference(actual.findings, expected.findings)) lines.push(`+ finding ${finding}`)
  for (const finding of difference(expected.findings, actual.findings)) lines.push(`- finding ${finding} (no longer reported)`)

  const overflowDelta = actual.page.overflowPx - expected.page.overflowPx
  if (Math.abs(overflowDelta) > overflowTolerancePx) {
    lines.push(`${overflowDelta > 0 ? "+" : "-"} page scroll overflow ${expected.page.overflowPx}px -> ${actual.page.overflowPx}px`)
  }

  const expectedIDs = Object.keys(expected.widgets), actualIDs = Object.keys(actual.widgets)
  for (const id of actualIDs.filter(id => !(id in expected.widgets))) lines.push(`+ widget "${id}" added`)
  for (const id of expectedIDs.filter(id => !(id in actual.widgets))) lines.push(`- widget "${id}" removed`)
  for (const id of expectedIDs.filter(id => id in actual.widgets)) {
    const before = expected.widgets[id], after = actual.widgets[id]
    const moved = before.box.map((value, index) => Math.abs(after.box[index] - value))
    const largest = Math.max(...moved)
    if (largest > tolerancePx) {
      lines.push(`~ widget "${id}" box [${before.box.join(", ")}] -> [${after.box.join(", ")}] (moved ${largest}px, tolerance ${tolerancePx}px)`)
    }
    if (before.state !== after.state) lines.push(`~ widget "${id}" state ${before.state} -> ${after.state}`)
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

/** The human-readable report printed when the check fails. */
export function formatProblems(problems, renderCount, baselinePath) {
  const changed = problems.length
  const body = problems.map(({ key, lines }) => [key, ...lines.map(line => `  ${line}`)].join("\n")).join("\n\n")
  return [
    `Visual matrix changed in ${changed} of ${renderCount} renders (baseline ${baselinePath}).`,
    "  + gained   - lost   ~ moved or changed",
    "",
    body,
    "",
    "If the change is intended, review it, then rewrite the baseline with --update.",
  ].join("\n")
}
