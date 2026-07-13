import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test"

const responsiveViewports = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
] as const

const rankedDashboardApplications = [
  "application-00246 Degraded in team-06",
  "application-00241 Degraded in team-01",
  "application-00236 Degraded in team-08",
  "application-00231 Degraded in team-03",
  "application-00226 Degraded in team-10",
  "application-00221 Degraded in team-05",
  "application-00216 Degraded in team-00",
  "application-00211 Degraded in team-07",
] as const

const matrixRowFixtures = [
  {
    project: "team-00/payments",
    projectLabel: "payments",
    health: "healthy",
    healthLabel: "Healthy",
    count: 5,
  },
  {
    project: "team-01/commerce",
    projectLabel: "commerce",
    health: "degraded",
    healthLabel: "Degraded",
    count: 5,
  },
] as const

const FACT_MINIMUM = { width: 4, height: 4 } as const
const ACTION_MINIMUM = { width: 24, height: 20 } as const
const scopedTableNamespaces = ["team-00", "team-01", "team-02", "team-03"]
const scopedTableTotal = 84

test.beforeEach(async ({ request }) => {
  await expectFixtureReady(request)
})

test("visibility guard rejects visually hidden operational facts", async ({ page }) => {
  await page.setContent(`
    <main>
      <span id="visible">Visible fact</span>
      <div style="opacity: 0"><span id="ancestor-opacity">Opacity fact</span></div>
      <span id="clip-path" style="clip-path: inset(50%)">Clip-path fact</span>
      <span id="legacy-clip" style="position: absolute; clip: rect(0, 0, 0, 0)">Legacy clip fact</span>
      <span id="classic-sr" style="position: absolute; width: 1px; height: 1px; overflow: hidden">Screen-reader fact</span>
      <span id="truncated-fact" style="display: block; width: 8px; overflow: hidden; white-space: nowrap">Healthy</span>
      <div style="position: relative; width: 24px; height: 18px; overflow: hidden">
        <span id="ancestor-clipped" style="position: absolute; left: 16px; top: 2px; width: 32px; height: 12px">Clipped fact</span>
      </div>
    </main>
  `)

  expect((await inspectRenderedVisibility(page.locator("#visible"))).violations).toEqual([])
  await expectVisibilityRule(page, "#ancestor-opacity", "opacity")
  await expectVisibilityRule(page, "#clip-path", "clip-path")
  await expectVisibilityRule(page, "#legacy-clip", "legacy-clip")
  await expectVisibilityRule(page, "#classic-sr", "visually-hidden-pattern")
  await expectVisibilityRule(page, "#truncated-fact", "target-overflow-clipped")
  await expectVisibilityRule(page, "#ancestor-clipped", "ancestor-overflow-clipped")
})

for (const viewport of responsiveViewports) {
  test(`${viewport.name} dashboard presents the authoritative eight-application preview`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto("/dashboard/")
    await expect(page.getByText("100/250 apps loaded", { exact: true })).toBeVisible()

    const tiles = page.locator('a[aria-label*=" in team-"]')
    await expect(
      tiles,
      `${viewport.name} dashboard health map must be bounded to exactly eight application tiles`,
    ).toHaveCount(8)
    expect(
      await tiles.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      ),
      `${viewport.name} dashboard health map must preserve authoritative server impact order`,
    ).toEqual([...rankedDashboardApplications])
    await expectNoHorizontalOverflow(page.locator("html"), `${viewport.name} document`)
  })

  test(`${viewport.name} fleet presentations reflow complete operational records without horizontal panning`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)

    await openFleetPresentation(page, "table")
    await expectNoHorizontalOverflow(page.locator("html"), `${viewport.name} table document`)
    const tableScroll = page.getByTestId("application-table-scroll")
    await expectSingleResponsiveSurface(
      tableScroll,
      `${viewport.name} application table scroll surface`,
    )
    await expectNoHorizontalOverflowIfPresent(
      tableScroll,
      `${viewport.name} application table scroll surface`,
    )
    await expectCompleteOperationalRow(
      page,
      page.getByTestId("application-row-team-01-application-00001"),
      tableScroll,
      {
        surface: `${viewport.name} application table row`,
        identity: "team-01/application-00001",
        target: "Unavailable delivery",
        stage: "production",
        health: "Degraded",
        sync: "Unknown",
        resources: "1",
      },
    )

    await openFleetPresentation(page, "queue")
    await expectNoHorizontalOverflow(page.locator("html"), `${viewport.name} queue document`)
    const queueScroll = page.getByTestId("attention-queue-scroll")
    await expectSingleResponsiveSurface(
      queueScroll,
      `${viewport.name} attention queue scroll surface`,
    )
    await expectNoHorizontalOverflowIfPresent(
      queueScroll,
      `${viewport.name} attention queue scroll surface`,
    )
    await expectCompleteOperationalRow(
      page,
      page.getByTestId("attention-row-team-06-application-00246"),
      queueScroll,
      {
        surface: `${viewport.name} attention queue row`,
        identity: "team-06/application-00246",
        target: "Unavailable delivery",
        stage: "production",
        health: "Degraded",
        sync: "Unknown",
        resources: "1",
        rank: "01",
        reason: "Degraded health",
      },
    )

    for (const [index, matrixFixture] of matrixRowFixtures.entries()) {
      await openFleetPresentation(page, "matrix", {
        rows: "project",
        columns: "health",
        project: matrixFixture.project,
        health: matrixFixture.health,
      }, matrixFixture.count)
      await expectNoHorizontalOverflow(
        page.locator("html"),
        `${viewport.name} ${matrixFixture.health} matrix document`,
      )
      const matrixScroll = page.getByTestId("fleet-matrix-scroll")
      await expectSingleResponsiveSurface(
        matrixScroll,
        `${viewport.name} ${matrixFixture.health} fleet matrix scroll surface`,
      )
      await expectNoHorizontalOverflowIfPresent(
        matrixScroll,
        `${viewport.name} ${matrixFixture.health} fleet matrix scroll surface`,
      )
      await expectCompactMatrixPopulatedRow(
        page,
        viewport.name,
        matrixFixture,
        matrixScroll,
      )

      if (index === matrixRowFixtures.length - 1) {
        expect.soft(
          await page.getByRole("list", { name: /fleet matrix/i }).count(),
          `${viewport.name} matrix must not render a duplicate mobile list subtree`,
        ).toBe(0)
      }
    }

    await openFleetPresentation(page, "treemap")
    await expectNoHorizontalOverflow(page.locator("html"), `${viewport.name} treemap document`)
    await expectTreemapLegend(page, viewport.name)
  })

  test(`${viewport.name} virtual table measures late rows and keyboard drill-down navigates`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await openFleetPresentation(
      page,
      "table",
      { namespace: scopedTableNamespaces },
      scopedTableTotal,
    )
    await expectLateTableDrillDown(
      page,
      page.getByTestId("application-table-scroll"),
      `${viewport.name} table`,
    )
  })

  test(`${viewport.name} virtual queue measures late rows and keyboard activation updates selection`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await openFleetPresentation(page, "queue")
    await expectLateQueueSelection(
      page,
      page.getByTestId("attention-queue-scroll"),
      `${viewport.name} queue`,
    )
  })
}

test("wide viewport retains the desktop table and matrix column relationships", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  await openFleetPresentation(page, "table")
  const tableScroll = page.getByTestId("application-table-scroll")
  const applicationTable = page.getByRole("table", { name: "Applications" })
  const applicationHeaders = await expectVisibleColumnHeaders(applicationTable, [
    "Application",
    "Target",
    "Health",
    "Sync",
    "Resources",
    "Authorized actions",
  ])
  const applicationRow = page.getByTestId("application-row-team-01-application-00001")
  await expect(tableScroll).toBeVisible()
  await expect(applicationRow).toBeVisible()
  await expectHorizontalColumnRelationship(
    applicationHeaders,
    applicationRow.getByRole("cell"),
    "wide application table",
  )

  await openFleetPresentation(page, "matrix")
  const matrixScroll = page.getByTestId("fleet-matrix-scroll")
  const matrixTable = page.getByRole("table", { name: "Fleet matrix" })
  const matrixHeaders = await expectVisibleColumnHeaders(matrixTable, [
    "Row",
    "Column",
    "Applications",
    "Targets",
    "Health",
  ])
  const matrixRow = matrixTable.locator("tbody").getByRole("row").first()
  await expect(matrixScroll).toBeVisible()
  await expect(matrixRow).toBeVisible()
  await expectHorizontalColumnRelationship(
    matrixHeaders,
    matrixRow.locator("th[scope='row'], td"),
    "wide fleet matrix",
  )
})

async function expectFixtureReady(request: APIRequestContext) {
  const response = await request.get("/readyz")
  expect(
    response.ok(),
    `compiled 250-application fixture must be ready before responsive assertions; /readyz returned ${response.status()}`,
  ).toBe(true)
  expect(await response.text()).toBe("ready\n")
}

async function openFleetPresentation(
  page: Page,
  view: "treemap" | "matrix" | "table" | "queue",
  query: Readonly<Record<string, string | readonly string[]>> = {},
  expectedTotal = 250,
) {
  const parameters = new URLSearchParams({ view })
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      parameters.set(key, value)
      continue
    }
    for (const item of value) parameters.append(key, item)
  }
  await page.goto(`/dashboard/applications?${parameters.toString()}`)
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
  await expect(
    page.locator(`[data-fleet-ready="${expectedTotal}"]`),
    `${view} must render its expected ${expectedTotal}-application result before layout assertions`,
  ).toBeVisible()
  if (view === "table" || view === "queue") {
    await expect(page.getByTestId("fleet-load-more-sentinel")).toContainText(
      `${Math.min(100, expectedTotal)} loaded / ${expectedTotal} indexed`,
    )
  }
}

async function expectCompactMatrixPopulatedRow(
  page: Page,
  viewportName: string,
  fixture: (typeof matrixRowFixtures)[number],
  scrollSurface: Locator,
) {
  const matrixTables = page.getByRole("table", { name: "Fleet matrix" })
  expect.soft(
    await matrixTables.count(),
    `${viewportName} ${fixture.health} matrix must keep one semantic table and no duplicate mobile table`,
  ).toBe(1)
  if ((await matrixTables.count()) !== 1) return

  const table = matrixTables.first()
  const populatedRows = table.locator("tbody").getByRole("row")
  expect.soft(
    await populatedRows.count(),
    `${viewportName} ${fixture.health} matrix fixture must produce one populated semantic row`,
  ).toBe(1)
  if ((await populatedRows.count()) !== 1) return

  const row = populatedRows.first()
  await row.scrollIntoViewIfNeeded()
  const description = `${viewportName} ${fixture.health} matrix row`
  const facts = [
    {
      description: `${description} namespaced identity`,
      locator: row.getByText(fixture.project, { exact: true }),
      text: fixture.project,
    },
    {
      description: `${description} group label`,
      locator: row.getByText(fixture.projectLabel, { exact: true }),
      text: fixture.projectLabel,
    },
    {
      description: `${description} column label`,
      locator: row.getByText(fixture.healthLabel, { exact: true }),
      text: fixture.healthLabel,
    },
    {
      description: `${description} application count`,
      locator: row.locator("[data-application-count]"),
      text: fixture.count.toString(),
    },
    {
      description: `${description} target count`,
      locator: row.locator("[data-target-count]"),
      text: fixture.count.toString(),
    },
    {
      description: `${description} textual health count`,
      locator: row.getByText(`${fixture.healthLabel} ${fixture.count}`, { exact: true }),
      text: `${fixture.healthLabel} ${fixture.count}`,
    },
  ]
  const containers = (await scrollSurface.count()) === 1
    ? [row, scrollSurface]
    : [row]
  for (const fact of facts) {
    await expectVisibleFactInside(page, fact.locator, fact.text, containers, fact.description)
  }
  expect.soft(
    await page.getByText(`${fixture.healthLabel} ${fixture.count}`, { exact: true }).count(),
    `${description} textual health/count must render once without a duplicate mobile subtree`,
  ).toBe(1)
}

async function expectSingleResponsiveSurface(surface: Locator, description: string) {
  expect.soft(await surface.count(), `${description} must expose one stable scroll contract`).toBe(1)
}

async function expectNoHorizontalOverflowIfPresent(
  surface: Locator,
  description: string,
) {
  if ((await surface.count()) !== 1) return
  await expectNoHorizontalOverflow(surface, description, true)
}

async function expectNoHorizontalOverflow(
  surface: Locator,
  description: string,
  soft = false,
) {
  const dimensions = await surface.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  const overflow = dimensions.scrollWidth - dimensions.clientWidth
  const assertion = soft ? expect.soft(overflow, overflowMessage()) : expect(overflow, overflowMessage())
  assertion.toBeLessThanOrEqual(1)

  function overflowMessage() {
    return `${description} must not require horizontal panning (client ${dimensions.clientWidth}px, scroll ${dimensions.scrollWidth}px)`
  }
}

interface OperationalRowExpectation {
  surface: string
  identity: string
  target: string
  stage: string
  health: string
  sync: string
  resources: string
  rank?: string
  reason?: string
}

async function expectCompleteOperationalRow(
  page: Page,
  row: Locator,
  scrollSurface: Locator,
  expected: OperationalRowExpectation,
) {
  const count = await row.count()
  expect.soft(count, `${expected.surface} must expose exactly one single-DOM record`).toBe(1)
  if (count !== 1) return

  await row.scrollIntoViewIfNeeded()
  const factElements = [
    {
      description: `${expected.surface} identity`,
      locator: row.getByText(expected.identity, { exact: true }),
      text: expected.identity,
    },
    {
      description: `${expected.surface} target`,
      locator: row.getByLabel("Target", { exact: true }),
      text: expected.target,
    },
    {
      description: `${expected.surface} stage`,
      locator: row.getByLabel("Stage", { exact: true }),
      text: expected.stage,
    },
    {
      description: `${expected.surface} health`,
      locator: row.getByLabel("Health status", { exact: true }),
      text: expected.health,
    },
    {
      description: `${expected.surface} sync`,
      locator: row.getByLabel("Sync status", { exact: true }),
      text: expected.sync,
    },
    {
      description: `${expected.surface} resources`,
      locator: row.getByLabel("Resource count", { exact: true }),
      text: expected.resources,
    },
  ]
  if (expected.rank) {
    factElements.push({
      description: `${expected.surface} rank`,
      locator: row.getByLabel("Queue rank", { exact: true }),
      text: expected.rank,
    })
  }
  if (expected.reason) {
    factElements.push({
      description: `${expected.surface} severity reason`,
      locator: row.getByLabel("Attention reason", { exact: true }),
      text: expected.reason,
    })
  }

  for (const fact of factElements) {
    await expectVisibleFactInside(
      page,
      fact.locator,
      fact.text,
      [row, scrollSurface],
      fact.description,
    )
  }

  for (const action of [
    `Sync ${expected.identity}`,
    `Rollback ${expected.identity}`,
    `Approve gate for ${expected.identity}`,
    `Retry pipeline for ${expected.identity}`,
  ]) {
    await expectVisibleInside(
      page,
      row.getByRole("button", { name: action, exact: true }),
      [row, scrollSurface],
      `${expected.surface} authorized action ${JSON.stringify(action)}`,
      ACTION_MINIMUM,
    )
  }
}

async function expectTreemapLegend(page: Page, viewportName: string) {
  const legend = page.getByRole("list", { name: "Treemap health legend" })
  const legendCount = await legend.count()
  expect.soft(
    legendCount,
    `${viewportName} treemap must expose one semantic text-plus-glyph health legend`,
  ).toBe(1)
  if (legendCount !== 1) return

  await legend.scrollIntoViewIfNeeded()
  await expectVisibleInside(page, legend, [], `${viewportName} treemap legend`)
  const entries = legend.getByRole("listitem")
  expect.soft(
    await entries.count(),
    `${viewportName} treemap legend must represent every visible fixture health`,
  ).toBe(3)
  for (const [index, label] of ["Degraded", "Progressing", "Healthy"].entries()) {
    const entry = entries.nth(index)
    await expectVisibleInside(
      page,
      entry,
      [legend],
      `${viewportName} treemap legend entry ${index + 1} for ${label}`,
    )
    await expectVisibleFactInside(
      page,
      entry.getByText(label, { exact: true }),
      label,
      [entry, legend],
      `${viewportName} treemap legend ${label} text`,
    )
    const glyph = entry.locator("svg[aria-hidden='true'], [data-health-glyph]")
    expect.soft(
      await glyph.count(),
      `${viewportName} treemap legend ${label} entry needs a non-color glyph`,
    ).toBe(1)
    if ((await glyph.count()) === 1) {
      await expectVisibleInside(
        page,
        glyph,
        [entry, legend],
        `${viewportName} treemap legend ${label} non-color glyph`,
      )
    }
  }
}

async function expectLateTableDrillDown(
  page: Page,
  scrollSurface: Locator,
  presentation: string,
) {
  const { identity, lateRow } = await prepareLateVirtualRow(
    page,
    scrollSurface,
    presentation,
  )
  const [namespace, name] = identity.split("/")
  const drillDown = lateRow.getByRole("link", {
    name: `Open application ${identity}`,
    exact: true,
  })
  const sharedNamespaceScope = new URL(page.url()).searchParams.getAll("namespace")
  expect(
    sharedNamespaceScope,
    `${presentation} must begin with a non-vacuous repeated shared namespace scope`,
  ).toEqual(scopedTableNamespaces)
  await expectVisibleInside(
    page,
    drillDown,
    [lateRow, scrollSurface],
    `${presentation} late-row native drill-down`,
    ACTION_MINIMUM,
  )
  await drillDown.focus()
  await expect(drillDown, `${presentation} drill-down must accept keyboard focus`).toBeFocused()
  await page.keyboard.press("Enter")
  await expect
    .poll(
      () => {
        const url = new URL(page.url())
        return {
          pathname: url.pathname,
          applicationNamespace: url.searchParams.get("application_namespace"),
          applicationName: url.searchParams.get("application_name"),
          sharedNamespaceScope: url.searchParams.getAll("namespace"),
          legacyName: url.searchParams.get("name"),
        }
      },
      { message: `${presentation} Enter drill-down must navigate to application detail` },
    )
    .toEqual({
      pathname: "/dashboard/application",
      applicationNamespace: namespace,
      applicationName: name,
      sharedNamespaceScope,
      legacyName: null,
    })
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible()
}

async function expectLateQueueSelection(
  page: Page,
  scrollSurface: Locator,
  presentation: string,
) {
  const { identity, lateRow } = await prepareLateVirtualRow(
    page,
    scrollSurface,
    presentation,
  )
  await expect(lateRow).toHaveAttribute("tabindex", "0")
  await expect(
    lateRow.locator(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
    `${presentation} row must remain the one keyboard selection target`,
  ).toHaveCount(0)
  await lateRow.focus()
  await expect(lateRow, `${presentation} late row must accept keyboard focus`).toBeFocused()
  await page.keyboard.press("Enter")
  await expect
    .poll(
      () => {
        const url = new URL(page.url())
        return {
          pathname: url.pathname.replace(/\/$/, ""),
          view: url.searchParams.get("view"),
          selected: url.searchParams.get("selected"),
        }
      },
      { message: `${presentation} Enter must select the canonical namespace/name` },
    )
    .toEqual({ pathname: "/dashboard/applications", view: "queue", selected: identity })
}

async function prepareLateVirtualRow(
  page: Page,
  scrollSurface: Locator,
  presentation: string,
) {
  await expect(
    scrollSurface,
    `${presentation} virtualizer must expose its stable scroll surface`,
  ).toBeVisible()
  await scrollSurface.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 2)
    element.dispatchEvent(new Event("scroll", { bubbles: true }))
  })

  const virtualRows = scrollSurface.locator("[data-index]")
  await expect
    .poll(
      async () => Math.max(...(await virtualRowIndices(virtualRows))),
      {
        message: `${presentation} must virtualize a row beyond index 75 after scrolling`,
      },
    )
    .toBeGreaterThan(75)

  const measured = await virtualRows.evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          index: Number(element.getAttribute("data-index")),
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        }
      })
      .filter((row) => Number.isFinite(row.index) && row.height > 0)
      .sort((left, right) => left.top - right.top),
  )
  expect(measured.length, `${presentation} must measure more than one virtual row`).toBeGreaterThan(1)
  for (let index = 0; index < measured.length - 1; index += 1) {
    const current = measured[index]
    const next = measured[index + 1]
    expect(
      current.bottom,
      `${presentation} virtual rows ${current.index} and ${next.index} must not overlap`,
    ).toBeLessThanOrEqual(next.top + 0.5)
  }

  const lateIndex = Math.max(...measured.map((row) => row.index))
  expect(lateIndex, `${presentation} keyboard target must be beyond index 75`).toBeGreaterThan(75)
  const lateRow = scrollSurface.locator(`[data-index="${lateIndex}"]`).last()
  const identity = await lateRow.getAttribute("aria-label")
  expect(identity, `${presentation} late row must expose namespace/name identity`).toMatch(
    /^[a-z0-9-]+\/[a-z0-9-]+$/,
  )
  await lateRow.scrollIntoViewIfNeeded()
  await expectVisibleInside(
    page,
    lateRow,
    [scrollSurface],
    `${presentation} late virtual row`,
  )
  return { identity: identity!, lateRow }
}

async function virtualRowIndices(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements
      .map((element) => Number(element.getAttribute("data-index")))
      .filter(Number.isFinite),
  )
}

async function expectVisibleColumnHeaders(table: Locator, expected: readonly string[]) {
  await expect(table).toBeVisible()
  const headers = table.getByRole("columnheader")
  await expect(headers).toHaveCount(expected.length)
  await expect(
    headers,
    "wide presentation must retain the complete ordered desktop column model",
  ).toHaveText([...expected])
  for (const header of await headers.all()) {
    await expect(header).toBeVisible()
  }
  return headers
}

async function expectHorizontalColumnRelationship(
  headers: Locator,
  cells: Locator,
  description: string,
) {
  const headerCount = await headers.count()
  await expect(
    cells,
    `${description} representative row must retain one fact cell per desktop column`,
  ).toHaveCount(headerCount)
  const headerBoxes = await visibleBoxes(headers, `${description} headers`)
  const cellBoxes = await visibleBoxes(cells, `${description} representative row cells`)
  expectIncreasingX(headerBoxes, `${description} headers`)
  expectIncreasingX(cellBoxes, `${description} representative row cells`)

  for (let index = 0; index < headerBoxes.length; index += 1) {
    expect(
      Math.abs(headerBoxes[index].x - cellBoxes[index].x),
      `${description} column ${index + 1} header and row fact must align on the x axis`,
    ).toBeLessThanOrEqual(8)
  }
}

async function visibleBoxes(locator: Locator, description: string) {
  const boxes: GeometryBox[] = []
  for (const [index, element] of (await locator.all()).entries()) {
    await expect(element, `${description} ${index + 1} must be visible`).toBeVisible()
    const box = await element.boundingBox()
    expect(box, `${description} ${index + 1} must have measurable geometry`).not.toBeNull()
    boxes.push(box!)
  }
  return boxes
}

function expectIncreasingX(boxes: readonly GeometryBox[], description: string) {
  for (let index = 1; index < boxes.length; index += 1) {
    expect(
      boxes[index].x - boxes[index - 1].x,
      `${description} ${index} and ${index + 1} must be distinct increasing desktop columns`,
    ).toBeGreaterThan(4)
  }
}

async function expectVisibleFactInside(
  page: Page,
  element: Locator,
  expectedText: string,
  containers: readonly Locator[],
  description: string,
) {
  await expect.soft(element, `${description} must contain its expected visible value`).toContainText(
    expectedText,
    { timeout: 1_500 },
  )
  await expectVisibleInside(page, element, containers, description)
}

async function expectVisibleInside(
  page: Page,
  element: Locator,
  containers: readonly Locator[],
  description: string,
  minimum: RenderedMinimum = FACT_MINIMUM,
) {
  await expect.soft(element, `${description} must be visibly rendered`).toBeVisible({
    timeout: 1_500,
  })

  let inspection: RenderedVisibilityInspection
  try {
    inspection = await inspectRenderedVisibility(element)
  } catch {
    return
  }
  expect.soft(
    inspection.violations,
    `${description} must not rely on hidden opacity, clipping, or visually-hidden ancestor styles`,
  ).toEqual([])

  const box = await element.boundingBox()
  expect.soft(box, `${description} must expose measurable geometry`).not.toBeNull()
  if (!box) return
  expect.soft(
    box.width,
    `${description} must have at least ${minimum.width}px of meaningful rendered width`,
  ).toBeGreaterThanOrEqual(minimum.width)
  expect.soft(
    box.height,
    `${description} must have at least ${minimum.height}px of meaningful rendered height`,
  ).toBeGreaterThanOrEqual(minimum.height)

  for (const container of containers) {
    const containerBox = await container.boundingBox()
    expect.soft(containerBox, `${description} container must expose measurable geometry`).not.toBeNull()
    if (containerBox) expectBoxInside(box, containerBox, `${description} inside its row/surface`)
  }

  const viewport = await page.evaluate(() => ({
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  expectBoxInside(box, viewport, `${description} inside the browser viewport`)
}

async function expectVisibilityRule(
  page: Page,
  selector: string,
  expectedRule: VisibilityRule,
) {
  const inspection = await inspectRenderedVisibility(page.locator(selector))
  expect(
    inspection.violations.map((violation) => violation.rule),
    `${selector} must exercise the ${expectedRule} visibility rejection`,
  ).toContain(expectedRule)
}

async function inspectRenderedVisibility(
  element: Locator,
): Promise<RenderedVisibilityInspection> {
  return element.evaluate((node) => {
    const violations: RenderedVisibilityInspection["violations"] = []
    const unclippedLegacy = (value: string) => {
      const normalized = value.trim().toLowerCase().replaceAll(",", " ").replace(/\s+/g, " ")
      return normalized === "auto" || normalized === "rect(auto auto auto auto)"
    }
    const hiddenOverflow = new Set(["hidden", "clip"])
    const targetRect = node.getBoundingClientRect()

    for (let current: Element | null = node; current; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      const tag = current.tagName.toLowerCase()
      if (style.display === "none") {
        violations.push({ rule: "display", tag, value: style.display })
      }
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        violations.push({ rule: "visibility", tag, value: style.visibility })
      }
      const opacity = Number.parseFloat(style.opacity)
      if (Number.isFinite(opacity) && opacity <= 0) {
        violations.push({ rule: "opacity", tag, value: style.opacity })
      }
      if (style.clipPath.trim().toLowerCase() !== "none") {
        violations.push({ rule: "clip-path", tag, value: style.clipPath })
      }
      if (!unclippedLegacy(style.clip)) {
        violations.push({ rule: "legacy-clip", tag, value: style.clip })
      }

      const rect = current.getBoundingClientRect()
      const positioned = style.position === "absolute" || style.position === "fixed"
      const clippedOverflow =
        hiddenOverflow.has(style.overflow) ||
        hiddenOverflow.has(style.overflowX) ||
        hiddenOverflow.has(style.overflowY)
      const clipsX = hiddenOverflow.has(style.overflowX) || hiddenOverflow.has(style.overflow)
      const clipsY = hiddenOverflow.has(style.overflowY) || hiddenOverflow.has(style.overflow)
      if (positioned && rect.width <= 1.5 && rect.height <= 1.5 && clippedOverflow) {
        violations.push({
          rule: "visually-hidden-pattern",
          tag,
          value: `${style.position} ${rect.width}x${rect.height} ${style.overflow}`,
        })
      }
      if (
        current === node &&
        ((clipsX && current.scrollWidth > current.clientWidth) ||
          (clipsY && current.scrollHeight > current.clientHeight))
      ) {
        violations.push({
          rule: "target-overflow-clipped",
          tag,
          value: `${current.scrollWidth}x${current.scrollHeight} scroll in ${current.clientWidth}x${current.clientHeight} client`,
        })
      }
      if (current !== node && (clipsX || clipsY)) {
        const clientLeft = rect.left + current.clientLeft
        const clientTop = rect.top + current.clientTop
        const clientRight = clientLeft + current.clientWidth
        const clientBottom = clientTop + current.clientHeight
        const tolerance = 0.5
        const clippedHorizontally =
          clipsX &&
          (targetRect.left < clientLeft - tolerance ||
            targetRect.right > clientRight + tolerance)
        const clippedVertically =
          clipsY &&
          (targetRect.top < clientTop - tolerance ||
            targetRect.bottom > clientBottom + tolerance)
        if (clippedHorizontally || clippedVertically) {
          violations.push({
            rule: "ancestor-overflow-clipped",
            tag,
            value: `target ${targetRect.left},${targetRect.top},${targetRect.right},${targetRect.bottom} outside client ${clientLeft},${clientTop},${clientRight},${clientBottom}`,
          })
        }
      }
    }
    return { violations }
  })
}

function expectBoxInside(
  inner: GeometryBox,
  outer: GeometryBox,
  description: string,
) {
  const tolerance = 1
  expect.soft(inner.x, `${description}: left edge`).toBeGreaterThanOrEqual(outer.x - tolerance)
  expect.soft(inner.y, `${description}: top edge`).toBeGreaterThanOrEqual(outer.y - tolerance)
  expect.soft(inner.x + inner.width, `${description}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + tolerance,
  )
  expect.soft(inner.y + inner.height, `${description}: bottom edge`).toBeLessThanOrEqual(
    outer.y + outer.height + tolerance,
  )
}

interface GeometryBox {
  x: number
  y: number
  width: number
  height: number
}

interface RenderedMinimum {
  width: number
  height: number
}

type VisibilityRule =
  | "display"
  | "visibility"
  | "opacity"
  | "clip-path"
  | "legacy-clip"
  | "visually-hidden-pattern"
  | "target-overflow-clipped"
  | "ancestor-overflow-clipped"

interface RenderedVisibilityInspection {
  violations: Array<{
    rule: VisibilityRule
    tag: string
    value: string
  }>
}
