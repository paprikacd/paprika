// Responsive check for the four Kubernetes widgets. It starts the widget lab's Vite dev server (no Go, no gallery),
// opens labs/widget-lab/tests/browser/kubernetes-responsive.html, which draws the production renderers with the
// production fixtures at the content widths of 2, 3, 4, 6 and 12 column tiles, and checks each viewport and theme:
// no horizontal overflow on a widget or any row, every throttle row on one line, the throttle header over its columns,
// and bar cells on one line. It also opens the lab's Kubernetes Fleet lens at each viewport.
//
// Needs labs/widget-lab/node_modules (npm ci --prefix labs/widget-lab). Screenshots go to
// artifacts/insights/kubernetes-responsive, or $KUBERNETES_RESPONSIVE_OUTPUT.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const lab = join(repository, "labs/widget-lab")
const output = resolve(process.env.KUBERNETES_RESPONSIVE_OUTPUT || join(repository, "artifacts/insights/kubernetes-responsive"))

// Canvas geometry (responsive-layout.ts): 12 columns with 16 px gaps. A 1512 px window leaves about 1464 px of canvas.
// Tile content is the tile less 24 px of padding.
const tileWidth = (canvas, w) => Math.floor(((canvas - 11 * 16) / 12) * w + (w - 1) * 16 - 24)
const viewports = [
  { width: 1512, height: 982, canvas: 1464, tiles: [2, 3, 4, 6, 12] },
  { width: 1024, height: 768, canvas: 976, tiles: [3, 4, 6, 12] },
  { width: 768, height: 1024, canvas: 720, tiles: [6, 12] },
  // Phones stack every tile at full width.
  { width: 390, height: 844, canvas: 358, tiles: [12] },
]

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, "127.0.0.1", done))
  const { port } = server.address()
  await new Promise(done => server.close(done))
  return port
}

async function startLab() {
  const port = await freePort()
  const child = spawn(process.execPath, [join(lab, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: lab, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", chunk => { log += chunk })
  child.stderr.on("data", chunk => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The lab dev server exited:\n${log}`)
    try {
      if ((await fetch(base)).ok) return { base, child }
    } catch { /* not listening yet */ }
    await new Promise(done => setTimeout(done, 500))
  }
  child.kill()
  throw new Error(`The lab dev server did not start in 120 s:\n${log}`)
}

/** Every layout problem in the page, as text. Runs in the browser. */
function layoutProblems() {
  const problems = []
  const name = element => `${element.closest("[data-harness]")?.dataset.harness ?? element.dataset.kubernetes}@${element.closest("[data-width]")?.dataset.width ?? "lens"}`
  const overflow = (element, what) => {
    if (element.scrollWidth > element.clientWidth + 1) problems.push(`${what} overflows: scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}`)
  }
  for (const section of document.querySelectorAll("[data-harness]")) overflow(section, `${name(section)} tile`)
  for (const widget of document.querySelectorAll("[data-kubernetes]")) {
    const id = name(widget)
    overflow(widget, id)
    const box = widget.getBoundingClientRect()
    // Text an ellipsis container clips is not overflow: only a box that is drawn past the widget counts.
    const clipped = element => {
      for (let parent = element.parentElement; parent && parent !== widget; parent = parent.parentElement) {
        if (["hidden", "clip"].includes(getComputedStyle(parent).overflowX)) return true
      }
      return false
    }
    for (const child of widget.querySelectorAll("*")) {
      const rect = child.getBoundingClientRect()
      if (rect.width && rect.right > box.right + 1 && getComputedStyle(child).position !== "absolute" && !clipped(child)) {
        problems.push(`${id}: ${child.tagName.toLowerCase()} "${(child.textContent || "").slice(0, 30)}" ends ${Math.round(rect.right - box.right)} px past the widget`)
        break
      }
    }
    if (widget.dataset.kubernetes === "throttle") {
      const grid = widget.querySelector("[style*='grid-template-columns']")
      const items = [...grid.children].flatMap(child => getComputedStyle(child).display === "contents" ? [...child.children] : [child])
      const heading = items[0], total = items[1]
      const rows = [...grid.children].filter(child => getComputedStyle(child).display === "contents")
      for (const row of rows) {
        const cells = [...row.children]
        const tops = new Set(cells.map(cell => Math.round(cell.getBoundingClientRect().top)))
        if (tops.size !== 1) problems.push(`${id}: row "${cells[0].textContent}" spans ${tops.size} lines`)
        for (const cell of [cells[0], cells[cells.length - 1]]) if (cell.getBoundingClientRect().height > 20) problems.push(`${id}: "${cell.textContent}" wraps (${Math.round(cell.getBoundingClientRect().height)} px)`)
        const last = cells[cells.length - 1].getBoundingClientRect()
        if (Math.abs(last.right - total.getBoundingClientRect().right) > 1) problems.push(`${id}: Total header is not over the totals column`)
        if (Math.abs(cells[0].getBoundingClientRect().left - heading.getBoundingClientRect().left) > 1) problems.push(`${id}: the group heading is not over the names`)
      }
    }
    if (widget.dataset.kubernetes === "bars") {
      for (const head of widget.querySelectorAll("[class*='cellHead']")) if (head.getBoundingClientRect().height > 20) problems.push(`${id}: bar label wraps: "${head.textContent}"`)
    }
  }
  return problems
}

const { base, child } = await startLab()
const browser = await chromium.launch()
const failures = []
try {
  await mkdir(output, { recursive: true })
  for (const viewport of viewports) {
    for (const colorScheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme, reducedMotion: "reduce" })
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", error => errors.push(String(error)))
      const widths = viewport.tiles.map(w => Math.min(tileWidth(viewport.canvas, w), viewport.width - 16))
      for (const preset of ["ready", "gaps"]) {
        await page.goto(`${base}/tests/browser/kubernetes-responsive.html?widths=${widths.join(",")}&theme=${colorScheme}&preset=${preset}`)
        await page.waitForFunction(count => document.querySelectorAll("[data-kubernetes]").length >= count, widths.length * 5, { timeout: 60_000 })
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        for (const problem of await page.evaluate(layoutProblems)) failures.push(`${viewport.width} ${colorScheme} ${preset}: ${problem}`)
        if (preset === "ready") {
          await page.screenshot({ path: join(output, `widgets-${viewport.width}-${colorScheme}.png`), fullPage: true })
          // One close-up per widget at the narrowest and the widest tile, which are the cases worth looking at.
          for (const width of new Set([Math.min(...widths), Math.max(...widths)])) {
            for (const section of await page.locator(`[data-width="${width}"]`).all()) {
              const key = await section.getAttribute("data-harness")
              await section.screenshot({ path: join(output, `${key}-${viewport.width}-${colorScheme}-${width}.png`) })
            }
          }
        }
      }
      await page.goto(`${base}/#kubernetes-fleet`)
      await page.waitForSelector("[data-kubernetes='throttle']", { timeout: 60_000 })
      await page.evaluate(() => new Promise(done => setTimeout(done, 500)))
      for (const problem of await page.evaluate(layoutProblems)) failures.push(`${viewport.width} ${colorScheme} fleet lens: ${problem}`)
      await page.screenshot({ path: join(output, `fleet-${viewport.width}-${colorScheme}.png`), fullPage: true })
      for (const error of errors) failures.push(`${viewport.width} ${colorScheme}: page error ${error}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  child.kill()
}
if (failures.length) console.error(failures.join("\n"))
assert.equal(failures.length, 0, `${failures.length} Kubernetes layout problems`)
console.log(`Kubernetes widgets fit at every tile width and viewport. Screenshots: ${output}`)
