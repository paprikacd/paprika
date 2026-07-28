import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test"

const baseURL = "http://127.0.0.1:3100"
const desktopViewport = { width: 1920, height: 1080 }
const APPLICATION_COUNT = 10_000
const INITIAL_SAMPLE_COUNT = 20
const SWITCH_SAMPLE_COUNT = 30
const INITIAL_P95_LIMIT_MS = 2_000
const SWITCH_P95_LIMIT_MS = 250
const MAX_TREEMAP_DOM_ELEMENTS = 200
const INITIAL_READY_MARK = "fleet-scale:initial-canvas-ready"
const readySelector = `[data-fleet-ready="${APPLICATION_COUNT}"]`

type Presentation = "treemap" | "matrix"

interface NavigationSample {
  durationMs: number
  navigationType: PerformanceNavigationTiming["type"]
}

interface TreemapDOMSnapshot {
  applicationNodeCount: number
  canvasCount: number
  descendantElementCount: number
  presentationControllerCount: number
}

interface ColdNavigationRun {
  context: BrowserContext
  page: Page
  samples: NavigationSample[]
}

test.setTimeout(180_000)

test("10,000-application fleet stays within Canvas presentation budgets", async ({
  browser,
  browserName,
  page,
}, testInfo) => {
  test.skip(
    browserName !== "chromium" || testInfo.project.name !== "chromium",
    "the controlled fleet scale gate runs once in the standard Chromium project",
  )
  await page.goto("/dashboard/applications?view=table", { waitUntil: "commit" })
  await expect(page.locator(readySelector)).toBeVisible()
  await expect(page.getByTestId("fleet-load-more-sentinel")).toContainText(
    "100 loaded / 10000 indexed",
  )
  await expect(page.getByRole("table", { name: "Applications" })).toHaveAttribute(
    "aria-rowcount",
    "10001",
  )

  const coldRun = await measureColdNavigations(browser)
  try {
    const measuredPage = coldRun.page
    const initialSamples = coldRun.samples
    const treemapDOM = await captureTreemapDOM(measuredPage)

    // Prime both post-load presentations before timing cached UI switches.
    await selectPresentation(measuredPage, "matrix")
    await selectPresentation(measuredPage, "treemap")

    const switchSamples: number[] = []
    for (let sample = 0; sample < SWITCH_SAMPLE_COUNT; sample += 1) {
      const target: Presentation = sample % 2 === 0 ? "matrix" : "treemap"
      switchSamples.push(
        await measurePresentationSwitch(measuredPage, target, sample),
      )
    }

    const initialDurations = initialSamples.map(({ durationMs }) => durationMs)
    const initialP95Ms = percentile95(initialDurations)
    const switchP95Ms = percentile95(switchSamples)
    const report = {
      applicationCount: APPLICATION_COUNT,
      thresholdsMs: {
        initialP95: INITIAL_P95_LIMIT_MS,
        switchP95: SWITCH_P95_LIMIT_MS,
      },
      initial: {
        sampleCount: INITIAL_SAMPLE_COUNT,
        p95Ms: roundMilliseconds(initialP95Ms),
        samplesMs: initialDurations.map(roundMilliseconds),
        navigationTypes: initialSamples.map(({ navigationType }) => navigationType),
      },
      switch: {
        sampleCount: SWITCH_SAMPLE_COUNT,
        p95Ms: roundMilliseconds(switchP95Ms),
        samplesMs: switchSamples.map(roundMilliseconds),
        presentations: Array.from(
          { length: SWITCH_SAMPLE_COUNT },
          (_, index): Presentation => index % 2 === 0 ? "matrix" : "treemap",
        ),
      },
      treemapDOM,
    }

    await writeScaleReport(testInfo, report)
    process.stdout.write(
      `FLEET_UI_INITIAL_P95_MS=${roundMilliseconds(initialP95Ms)}\n`,
    )
    process.stdout.write(
      `FLEET_UI_SWITCH_P95_MS=${roundMilliseconds(switchP95Ms)}\n`,
    )

    expect(initialSamples).toHaveLength(INITIAL_SAMPLE_COUNT)
    expect(
      initialSamples.every(({ navigationType }) => navigationType === "navigate"),
    ).toBe(true)
    expect(treemapDOM.canvasCount).toBe(1)
    expect(treemapDOM.presentationControllerCount).toBe(1)
    expect(treemapDOM.applicationNodeCount).toBe(0)
    expect(
      treemapDOM.descendantElementCount,
      "the Canvas presentation must keep its DOM bounded independently of fleet size",
    ).toBeLessThan(MAX_TREEMAP_DOM_ELEMENTS)
    expect(
      initialP95Ms,
      `initial fleet query plus Canvas render p95 must be below ${INITIAL_P95_LIMIT_MS} ms`,
    ).toBeLessThan(INITIAL_P95_LIMIT_MS)
    expect(
      switchP95Ms,
      `post-load presentation switch p95 must be below ${SWITCH_P95_LIMIT_MS} ms`,
    ).toBeLessThan(SWITCH_P95_LIMIT_MS)
  } finally {
    await coldRun.context.close()
  }
})

async function measureColdNavigations(browser: Browser): Promise<ColdNavigationRun> {
  const samples: NavigationSample[] = []
  let retainedContext: BrowserContext | undefined
  let retainedPage: Page | undefined

  try {
    for (let sample = 0; sample < INITIAL_SAMPLE_COUNT; sample += 1) {
      const context = await browser.newContext({
        baseURL,
        reducedMotion: "no-preference",
        viewport: desktopViewport,
      })
      let retainContext = false
      try {
        const measuredPage = await context.newPage()
        await installInitialCanvasReadyMark(measuredPage)
        await measuredPage.goto("/dashboard/applications", { waitUntil: "commit" })
        samples.push(await readInitialNavigationSample(measuredPage))

        if (sample === INITIAL_SAMPLE_COUNT - 1) {
          retainedContext = context
          retainedPage = measuredPage
          retainContext = true
        }
      } finally {
        if (!retainContext) await context.close()
      }
    }

    if (!retainedContext || !retainedPage) {
      throw new Error("the final cold navigation context was not retained")
    }
    return { context: retainedContext, page: retainedPage, samples }
  } catch (error) {
    await retainedContext?.close()
    throw error
  }
}

async function installInitialCanvasReadyMark(page: Page) {
  await page.addInitScript(
    ({ markName, selector }) => {
      const canvasIsReady = () => {
        const inventory = document.querySelector<HTMLElement>(selector)
        const controller = inventory?.querySelector<HTMLElement>(
          '[role="application"][aria-label="Fleet treemap"]',
        )
        const canvas = controller?.querySelector<HTMLCanvasElement>("canvas")
        return Boolean(
          inventory &&
            controller &&
            controller.getClientRects().length > 0 &&
            canvas &&
            canvas.width > 0 &&
            canvas.height > 0 &&
            canvas.clientWidth > 0 &&
            canvas.clientHeight > 0,
        )
      }

      const waitForCanvas = () => {
        if (!canvasIsReady()) {
          window.requestAnimationFrame(waitForCanvas)
          return
        }

        // The first frame observes the committed marker and completed draw
        // effect. Two further frames guarantee that draw reached a paint before
        // the navigation timer stops.
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!canvasIsReady()) {
              window.requestAnimationFrame(waitForCanvas)
              return
            }
            if (performance.getEntriesByName(markName, "mark").length === 0) {
              performance.mark(markName)
            }
          })
        })
      }

      window.requestAnimationFrame(waitForCanvas)
    },
    { markName: INITIAL_READY_MARK, selector: readySelector },
  )
}

async function readInitialNavigationSample(page: Page): Promise<NavigationSample> {
  await page.waitForFunction(
    (markName) => performance.getEntriesByName(markName, "mark").length === 1,
    INITIAL_READY_MARK,
    { polling: "raf" },
  )
  await expect(page.locator(readySelector)).toBeVisible()
  await expect(page.getByRole("application", { name: "Fleet treemap" })).toBeVisible()

  return page.evaluate((markName) => {
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined
    const ready = performance.getEntriesByName(markName, "mark")[0]
    if (!navigation || !ready) {
      throw new Error("navigation and fleet Canvas readiness marks are required")
    }
    return {
      durationMs: ready.startTime - navigation.startTime,
      navigationType: navigation.type,
    }
  }, INITIAL_READY_MARK)
}

async function captureTreemapDOM(page: Page): Promise<TreemapDOMSnapshot> {
  const region = page.getByRole("region", { name: "Fleet map" })
  await expect(region).toBeVisible()
  return region.evaluate((element) => ({
    applicationNodeCount: element.querySelectorAll(
      '[data-application-id], [data-application-key], [data-row-key], [role="row"], [role="listitem"]',
    ).length,
    canvasCount: element.querySelectorAll("canvas").length,
    descendantElementCount: element.querySelectorAll("*").length,
    presentationControllerCount: element.querySelectorAll(
      '[role="application"][aria-label="Fleet treemap"]',
    ).length,
  }))
}

async function selectPresentation(page: Page, presentation: Presentation) {
  const button = presentationButton(page, presentation)
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator(readySelector)).toBeVisible()
  await expect(presentationSurface(page, presentation)).toBeVisible()
  if (presentation === "treemap") {
    await expect
      .poll(() =>
        page
          .getByRole("application", { name: "Fleet treemap" })
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) =>
            canvas.width > 0 && canvas.height > 0,
          ),
      )
      .toBe(true)
  }
  await waitForTwoAnimationFrames(page)
}

async function measurePresentationSwitch(
  page: Page,
  presentation: Presentation,
  sample: number,
): Promise<number> {
  const startMark = `fleet-scale:switch:${sample}:start`
  const endMark = `fleet-scale:switch:${sample}:painted`
  const measureName = `fleet-scale:switch:${sample}`
  const label = presentationLabel(presentation)

  await page.evaluate(
    ({ end, ready, start, targetLabel, targetPresentation }) => {
      const targetIsReady = () => {
        const inventory = document.querySelector<HTMLElement>(ready)
        const button = document.querySelector<HTMLButtonElement>(
          `button[aria-label="Show ${targetLabel} view"][aria-pressed="true"]`,
        )
        const surface = targetPresentation === "matrix"
          ? document.querySelector<HTMLElement>('table[aria-label="Fleet matrix"]')
          : document.querySelector<HTMLElement>(
              '[role="application"][aria-label="Fleet treemap"]',
            )
        const canvas = targetPresentation === "treemap"
          ? surface?.querySelector<HTMLCanvasElement>("canvas")
          : undefined
        return Boolean(
          inventory &&
            button &&
            surface &&
            surface.getClientRects().length > 0 &&
            (targetPresentation !== "treemap" ||
              (canvas &&
                canvas.width > 0 &&
                canvas.height > 0 &&
                canvas.clientWidth > 0 &&
                canvas.clientHeight > 0)),
        )
      }

      const waitForTarget = () => {
        if (!targetIsReady()) {
          window.requestAnimationFrame(waitForTarget)
          return
        }
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!targetIsReady()) {
              window.requestAnimationFrame(waitForTarget)
              return
            }
            performance.mark(end)
          })
        })
      }

      performance.clearMarks(start)
      performance.clearMarks(end)
      performance.mark(start)
      window.requestAnimationFrame(waitForTarget)
    },
    {
      end: endMark,
      ready: readySelector,
      start: startMark,
      targetLabel: label,
      targetPresentation: presentation,
    },
  )

  await presentationButton(page, presentation).click()
  await page.waitForFunction(
    (markName) => performance.getEntriesByName(markName, "mark").length === 1,
    endMark,
    { polling: "raf" },
  )
  await expect(page.locator(readySelector)).toBeVisible()
  await expect(presentationButton(page, presentation)).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(presentationSurface(page, presentation)).toBeVisible()

  return page.evaluate(
    ({ end, measure, start }) => {
      performance.clearMeasures(measure)
      return performance.measure(measure, start, end).duration
    },
    { end: endMark, measure: measureName, start: startMark },
  )
}

function presentationButton(page: Page, presentation: Presentation) {
  return page.getByRole("button", {
    name: `Show ${presentationLabel(presentation)} view`,
  })
}

function presentationSurface(page: Page, presentation: Presentation) {
  return presentation === "treemap"
    ? page.getByRole("application", { name: "Fleet treemap" })
    : page.getByRole("table", { name: "Fleet matrix" })
}

function presentationLabel(presentation: Presentation) {
  return presentation === "treemap" ? "Treemap" : "Matrix"
}

async function waitForTwoAnimationFrames(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolveFrame) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolveFrame())
      })
    }),
  )
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("p95 requires at least one finite sample")
  }
  const ordered = [...samples].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3))
}

async function writeScaleReport(
  testInfo: TestInfo,
  report: Record<string, unknown>,
) {
  const artifactPath = resolve(
    testInfo.config.rootDir,
    "..",
    "..",
    "artifacts",
    "fleet-scale",
    "ui-scale.json",
  )
  await mkdir(dirname(artifactPath), { recursive: true })
  await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}
