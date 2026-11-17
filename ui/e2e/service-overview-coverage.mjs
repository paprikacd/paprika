import assert from "node:assert/strict"

export const finitePoints = series => (series.points ?? []).filter(point => Number.isFinite(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp)
export function assertCoverage({ kind, body, widget, service, expected = {} }) {
  const nonempty = kind === "traces" ? !!body.traces?.length : (body.series ?? []).some(series => finitePoints(series).length)
  if (expected.state === "empty") {
    assert.equal(nonempty, false, `${widget.id} must be empty for the explicit missing-data case ${service}`)
    return false
  }
  assert.equal(nonempty, true, `${widget.id} must have data for ${service}`)
  if (kind === "traces") {
    for (const trace of body.traces) assert.equal(trace.service, expected.traceService ?? service, `${widget.id} returned traces for the wrong service`)
  } else {
    const minimum = Math.max(expected.minSamples ?? 1, widget.options?.showSparkline || widget.type === "timeseries" ? 2 : 1)
    for (const series of body.series) assert.ok(finitePoints(series).length >= minimum, `${widget.id} must have at least ${minimum} finite observations in every series for ${service}`)
  }
  return true
}
