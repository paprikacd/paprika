import {
  expect,
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

import {
  QUERY_FLEET_MAP_PATH,
  auditExactFleetMapSubset,
  assertExactFleetMap,
  expectCompleteHeatmap,
  independentStableIdDigest,
  observeFleetMapResponses,
  requestNamespaces,
  type ExactFleetMapExpectation,
  type FleetMapCapture,
  type FleetMapOracle,
} from "./helpers/fleet-map-oracle"
import {
  expectedLiveFilterStableIds,
  fixtureModeFromEnvironment,
} from "./helpers/fleet-admin-config"
import { installRuntimeAudit, type RuntimeAudit } from "./helpers/runtime-audit"

const runNamespace = requiredDNSLabel(
  "PAPRIKA_E2E_RUN_NAMESPACE",
  process.env.PAPRIKA_E2E_RUN_NAMESPACE ?? "team-00",
)
const fixtureMode = fixtureModeFromEnvironment(process.env)
const runId = process.env.PAPRIKA_E2E_RUN_ID
const reviewedSubject =
  process.env.PAPRIKA_E2E_ADMIN_SUBJECT ??
  "system:serviceaccount:paprika-e2e:reviewed-fleet-admin"
const expectedStableIds = expectedApplicationStableIds(runNamespace)
const expectedCount = optionalPositiveInteger(
  "PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT",
  process.env.PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT,
) ?? expectedStableIds.length
const computedDigest = independentStableIdDigest(expectedStableIds)
const expectedDigest =
  process.env.PAPRIKA_E2E_EXPECTED_APPLICATION_DIGEST ?? computedDigest
const expectedProject =
  process.env.PAPRIKA_E2E_EXPECTED_PROJECT ?? `${runNamespace}/payments`
const expectedCluster =
  process.env.PAPRIKA_E2E_EXPECTED_CLUSTER ?? `${runNamespace}/delivery-primary`
const expectedStage = process.env.PAPRIKA_E2E_EXPECTED_STAGE ?? "production"
const detailApplication =
  process.env.PAPRIKA_E2E_DETAIL_APPLICATION ?? "checkout-service"
const exactFleet: ExactFleetMapExpectation = {
  namespace: runNamespace,
  stableIds: expectedStableIds,
  count: expectedCount,
  digest: expectedDigest,
}
const expectedDelivery = expectedDeliveryFixture()

if (fixtureMode === "live") {
  if (!runId) throw new Error("PAPRIKA_E2E_RUN_ID is required for the live admin proxy")
  requiredDNSLabel("PAPRIKA_E2E_RUN_ID", runId)
  if (runNamespace !== `paprika-fleet-e2e-${runId}`) {
    throw new Error("PAPRIKA_E2E_RUN_NAMESPACE does not belong to PAPRIKA_E2E_RUN_ID")
  }
  for (const name of [
    "PAPRIKA_E2E_ADMIN_SUBJECT",
    "PAPRIKA_E2E_EXPECTED_APPLICATION_IDS",
    "PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT",
    "PAPRIKA_E2E_EXPECTED_APPLICATION_DIGEST",
    "PAPRIKA_E2E_EXPECTED_PROJECT",
    "PAPRIKA_E2E_EXPECTED_CLUSTER",
    "PAPRIKA_E2E_EXPECTED_STAGE",
    "PAPRIKA_E2E_DETAIL_APPLICATION",
  ] as const) {
    if (!process.env[name]) throw new Error(`${name} is required for the live admin proxy`)
  }
}

if (expectedCount !== expectedStableIds.length) {
  throw new Error(
    `PAPRIKA_E2E_EXPECTED_APPLICATION_COUNT=${expectedCount} does not match ` +
      `${expectedStableIds.length} exact identities`,
  )
}
if (expectedDigest !== computedDigest) {
  throw new Error(
    `PAPRIKA_E2E_EXPECTED_APPLICATION_DIGEST=${expectedDigest} does not match ` +
      `the independently computed ${computedDigest}`,
  )
}
if (!expectedStableIds.includes(`a:${runNamespace}/${detailApplication}`)) {
  throw new Error(
    `PAPRIKA_E2E_DETAIL_APPLICATION=${detailApplication} is not in the exact fixture inventory`,
  )
}

type AcceptanceFixtures = {
  runtimeAudit: RuntimeAudit
  fleetMapOracle: FleetMapOracle
}

const test = base.extend<AcceptanceFixtures>({
  runtimeAudit: [
    async ({ page }, use) => {
      const audit = installRuntimeAudit(page, {
        allowIntentionalUnscoped: fixtureMode !== "live",
      })
      audit.expectFleetRun(exactFleet)
      await audit.ready()
      await use(audit)
      await audit.assertClean()
    },
    { auto: true },
  ],
  fleetMapOracle: [
    async ({ page }, use) => {
      const oracle = observeFleetMapResponses(page)
      await use(oracle)
      await oracle.stop()
    },
    { auto: true },
  ],
})

test.setTimeout(180_000)

base("local browser audit rejects a foreign nested ApplicationSummary", async ({ page }) => {
  base.skip(fixtureMode === "live", "negative route replacement is local-only")
  const audit = installRuntimeAudit(page)
  audit.expectFleetRun(exactFleet)
  await audit.ready()
  let replaced = false
  await page.route(
    "**/paprika.v1.PaprikaService/QueryApplications",
    async (route) => {
      const response = await route.fetch()
      const body = await response.json() as {
        applications?: Array<{
          identity?: { namespace?: string; name?: string }
        }>
      }
      const request = route.request().postDataJSON() as {
        filter?: { namespaces?: string[] }
      }
      if (
        request.filter?.namespaces?.length === 1 &&
        request.filter.namespaces[0] === runNamespace &&
        body.applications?.[0]?.identity
      ) {
        body.applications[0].identity.namespace = "foreign"
        replaced = true
      }
      await route.fulfill({ response, json: body })
    },
  )
  await page.goto(`/dashboard/applications/?namespace=${runNamespace}&view=heatmap`)
  await expect(page.locator(`[data-fleet-ready="${expectedCount}"]`)).toBeVisible()
  await page.getByRole("button", { name: "Show Table view" }).click()
  await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
  expect(replaced, "the browser test must replace an actual nested protojson identity").toBe(true)
  await expect(audit.assertClean()).rejects.toThrow(/foreign-namespace fixture objects/u)
})

base("runtime audit rejects an unscoped fleet query from a selected URL by default", async ({
  page,
}) => {
  base.skip(fixtureMode === "live", "negative namespace interaction is local-only")
  const audit = installRuntimeAudit(page, { allowIntentionalUnscoped: true })
  audit.expectFleetRun(exactFleet)
  await audit.ready()
  const oracle = observeFleetMapResponses(page)
  await page.goto(`/dashboard/applications/?namespace=${runNamespace}&view=heatmap`)
  await expectCompleteHeatmap(page, oracle, expectedCount)
  await deselectNamespaceOption(page, oracle)
  await expect(audit.assertClean()).rejects.toThrow(/request[.]filter[.]namespaces/u)
  await oracle.stop()
})

base("runtime audit consumes one explicit local unscoped fleet-query allowance", async ({
  page,
}) => {
  base.skip(fixtureMode === "live", "intentional unscoped query is local-only")
  const audit = installRuntimeAudit(page, { allowIntentionalUnscoped: true })
  audit.expectFleetRun(exactFleet)
  await audit.ready()
  const oracle = observeFleetMapResponses(page)
  await page.goto(`/dashboard/applications/?namespace=${runNamespace}&view=heatmap`)
  await expectCompleteHeatmap(page, oracle, expectedCount)
  audit.allowUnscopedQueryOnce(QUERY_FLEET_MAP_PATH)
  await deselectNamespaceOption(page, oracle)
  await audit.assertUnscopedQueryAllowanceConsumed(QUERY_FLEET_MAP_PATH)
  await audit.assertClean()
  await oracle.stop()
})

base("runtime audit rejects a second unscoped fleet query after one allowance", async ({
  page,
}) => {
  base.skip(fixtureMode === "live", "negative namespace interaction is local-only")
  const audit = installRuntimeAudit(page, { allowIntentionalUnscoped: true })
  audit.expectFleetRun(exactFleet)
  await audit.ready()
  const oracle = observeFleetMapResponses(page)
  await page.goto(`/dashboard/applications/?namespace=${runNamespace}&view=heatmap`)
  await expectCompleteHeatmap(page, oracle, expectedCount)
  audit.allowUnscopedQueryOnce(QUERY_FLEET_MAP_PATH)
  const { option: namespaceOption } = await deselectNamespaceOption(page, oracle)
  await audit.assertUnscopedQueryAllowanceConsumed(QUERY_FLEET_MAP_PATH)
  await namespaceOption.focus()
  await page.keyboard.press("Space")
  await expectScopeInURL(page)
  await expectCompleteHeatmap(page, oracle, expectedCount)
  const secondUnscopedCaptureIndex = oracle.captures.length
  await issueUnscopedFleetMapQuery(page)
  await expect.poll(
    () => oracle.captures.slice(secondUnscopedCaptureIndex).some(
      (capture) => requestNamespaces(capture.request).length === 0,
    ),
  ).toBe(true)
  await expect(audit.assertClean()).rejects.toThrow(/request[.]filter[.]namespaces/u)
  await oracle.stop()
})

base("live runtime configuration refuses the unscoped fleet-query capability", async ({
  page,
}) => {
  const audit = installRuntimeAudit(page, { allowIntentionalUnscoped: false })
  await audit.ready()
  expect(() => audit.allowUnscopedQueryOnce(QUERY_FLEET_MAP_PATH))
    .toThrow(/disabled for this runtime audit/u)
  await audit.assertClean()
})

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`${viewport.name} validates every run-scoped fleet view through the reviewed admin session`, async ({
    page,
    fleetMapOracle,
    runtimeAudit,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    const scope = new URLSearchParams({
      namespace: runNamespace,
      view: "heatmap",
      group: "namespace",
    })
    await page.goto(`/dashboard/applications/?${scope}`)

    const verified = await expectCompleteHeatmap(page, fleetMapOracle, expectedCount)
    assertExactFleetMap(verified.capture, exactFleet)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Applications heatmap`)
    await assertCompleteHeatmapInteraction(page, verified.host)
    await assertScopeControls(
      page,
      fleetMapOracle,
      runtimeAudit,
      verified.capture,
    )
    await attachView(
      page,
      testInfo,
      `${viewport.name}-applications-heatmap-grouped-namespace`,
    )

    const activeApplication = await openFocusedHeatmapApplication(page, verified.host)
    expect(expectedStableIds).toContain(`a:${runNamespace}/${activeApplication}`)
    await expectScopeInURL(page)
    await expect(page.getByRole("heading", { level: 1, name: activeApplication }))
      .toBeVisible()
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} keyboard-opened Application detail`)
    await attachView(page, testInfo, `${viewport.name}-keyboard-application-detail`)
    const backToDashboard = page.getByRole("link", { name: "Dashboard", exact: true })
    await expectScopeInHref(backToDashboard)
    await backToDashboard.click()
    await expectScopeInURL(page)
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible()
    const overview = await expectCompleteHeatmap(page, fleetMapOracle, expectedCount)
    assertExactFleetMap(overview.capture, exactFleet)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Overview`)
    await attachView(page, testInfo, `${viewport.name}-overview`)

    for (const presentation of ["heatmap", "treemap", "matrix", "table", "queue"] as const) {
      const query = new URLSearchParams({ namespace: runNamespace, view: presentation })
      await page.goto(`/dashboard/applications/?${query}`)
      await expect(page.locator(`[data-fleet-ready="${expectedCount}"]`)).toBeVisible()
      if (presentation === "heatmap") {
        const exact = await expectCompleteHeatmap(page, fleetMapOracle, expectedCount)
        assertExactFleetMap(exact.capture, exactFleet)
      } else if (presentation === "treemap") {
        await expect(page.getByRole("application", { name: "Fleet treemap" })).toBeVisible()
      } else if (presentation === "matrix") {
        await expect(page.getByRole("table", { name: "Fleet matrix" })).toBeVisible()
      } else if (presentation === "table") {
        await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
      } else {
        await expect(page.getByRole("region", { name: "Attention queue" })).toBeVisible()
      }
      await assertPresentationGeometry(page, presentation)
      await expect(page.getByText(/sampled (preview|subset)|preview only/iu)).toHaveCount(0)
      await assertAdminSession(page)
      await assertViewportRoute(page, `${viewport.name} Applications ${presentation}`)
      await attachView(
        page,
        testInfo,
        presentation === "heatmap"
          ? `${viewport.name}-applications-heatmap-default`
          : `${viewport.name}-applications-${presentation}`,
      )
    }

    const releases = await navigateToScopedResponse(
      page,
      "/paprika.v1.PaprikaService/QueryReleases",
      `/dashboard/releases/?namespace=${runNamespace}`,
    )
    await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
    await expect(page.getByText(runNamespace, { exact: true }).first()).toBeVisible()
    assertExactReleases(releases)
    await assertRenderedReleases(page)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Releases`)
    await attachView(page, testInfo, `${viewport.name}-releases`)

    const rollouts = await navigateToScopedResponse(
      page,
      "/paprika.v1.PaprikaService/ListRollouts",
      `/dashboard/rollouts/?namespace=${runNamespace}`,
    )
    await expect(page.getByRole("heading", { level: 1, name: "Rollouts" })).toBeVisible()
    await expect(page.getByText(runNamespace, { exact: true }).first()).toBeVisible()
    assertExactRollouts(rollouts)
    await assertRenderedRollouts(page)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Rollouts`)
    await attachView(page, testInfo, `${viewport.name}-rollouts`)

    const pipelinesResponse = await navigateToScopedResponse(
      page,
      "/paprika.v1.PaprikaService/ListPipelines",
      `/dashboard/?namespace=${runNamespace}#pipelines`,
    )
    const pipelines = page.locator("#pipelines")
    await expect(pipelines).toBeVisible()
    await expect(pipelines.getByRole("heading", { name: "Pipelines" })).toBeVisible()
    assertExactPipelines(pipelinesResponse)
    await assertRenderedPipelines(pipelines)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Pipelines`)
    await attachView(page, testInfo, `${viewport.name}-pipelines`)

    await page.goto(
      `/dashboard/application/?namespace=${runNamespace}` +
        `&application_namespace=${runNamespace}&application_name=${detailApplication}`,
    )
    await expect(page.getByRole("heading", { level: 1, name: detailApplication })).toBeVisible()
    await expectScopeInURL(page)
    const applicationBack = page.getByRole("link", { name: "Dashboard", exact: true })
    await expectScopeInHref(applicationBack)
    await assertAdminSession(page)
    await assertViewportRoute(page, `${viewport.name} Application detail`)
    await attachView(page, testInfo, `${viewport.name}-application-detail`)
  })
}

async function assertScopeControls(
  page: Page,
  fleetMapOracle: FleetMapOracle,
  runtimeAudit: RuntimeAudit,
  baseline: FleetMapCapture,
) {
  const cases = [
    {
      plural: "Projects",
      parameter: "project",
      search: expectedProject,
      requestField: "projects",
      requestValue: expectedNamespacedKey(expectedProject),
      selection: {
        field: "project",
        value: expectedNamespacedKey(expectedProject),
      },
    },
    {
      plural: "Clusters",
      parameter: "cluster",
      search: expectedCluster,
      requestField: "clusters",
      requestValue: expectedNamespacedKey(expectedCluster),
      selection: {
        field: "cluster",
        value: expectedNamespacedKey(expectedCluster),
      },
    },
    {
      plural: "Stages",
      parameter: "stage",
      search: expectedStage,
      requestField: "stages",
      requestValue: expectedStage,
      selection: {
        field: "stage",
        value: expectedStage,
      },
    },
  ] as const

  for (const scope of cases) {
    const trigger = page.getByRole("button", { name: new RegExp(`^${scope.plural},`) })
    await trigger.click()
    const dialog = page.getByRole("dialog", { name: `Choose ${scope.plural}` })
    await expect(dialog).toBeVisible()
    const search = dialog.getByRole("searchbox")
    await expect(search).toBeFocused()
    await search.fill(scope.search)
    const option = dialog.locator("label").filter({ hasText: scope.search })
      .getByRole("checkbox")
    await expect(option).toBeVisible()
    await option.focus()
    const selectedCaptureIndex = fleetMapOracle.captures.length
    await page.keyboard.press("Space")
    await expect.poll(() => new URL(page.url()).searchParams.getAll(scope.parameter))
      .toEqual([scope.search])
    await expect.poll(
      () => fleetMapOracle.captures.slice(selectedCaptureIndex).some(
        (capture) => isExactSelectedScopeRequest(capture, scope.requestField, scope.requestValue),
      ),
      {
        message:
          `${scope.plural} selection must issue an exact run-namespaced QueryFleetMap request`,
      },
    ).toBe(true)
    const selectedCapture = fleetMapOracle.captures.slice(selectedCaptureIndex).find(
      (capture) => isExactSelectedScopeRequest(capture, scope.requestField, scope.requestValue),
    )
    expect(selectedCapture).toBeDefined()
    const subset = auditExactFleetMapSubset(
      baseline,
      selectedCapture!,
      scope.selection,
    )
    expect(
      subset.expectedStableIds.length,
      `${scope.plural} must match at least one baseline Application`,
    ).toBeGreaterThan(0)
    expect(
      subset.expectedStableIds.length,
      `${scope.plural} must narrow the baseline Application inventory`,
    ).toBeLessThan(baseline.stableIds.length)
    if (fixtureMode === "live") {
      expect(
        subset.expectedStableIds,
        `${scope.plural} live fixture subset identities`,
      ).toEqual(
        expectedLiveFilterStableIds(runNamespace, scope.selection.field),
      )
    }
    expect(
      subset.violations,
      `${scope.plural} response must equal the exact baseline-derived metadata subset`,
    ).toEqual([])
    await expectRenderedFleetMapCapture(page, selectedCapture!)

    const selected = dialog.locator("label").filter({ hasText: scope.search })
      .getByRole("checkbox")
    await expect(selected).toBeChecked()
    const clear = dialog.getByRole("button", {
      name: `Clear ${scope.plural} selection`,
    })
    await clear.focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => new URL(page.url()).searchParams.getAll(scope.parameter)).toEqual([])
    const restored = await expectCompleteHeatmap(page, fleetMapOracle, expectedCount)
    assertExactFleetMap(restored.capture, exactFleet)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  }

  const namespaceTrigger = page.getByRole("button", { name: /^Namespaces,/u })
  const namespaceCaptureIndex = fleetMapOracle.captures.length
  await namespaceTrigger.click()
  const namespaceDialog = page.getByRole("dialog", { name: "Choose Namespaces" })
  await namespaceDialog.getByRole("searchbox").fill(runNamespace)
  const namespaceOption = namespaceDialog.locator("label").filter({ hasText: runNamespace })
    .getByRole("checkbox")
  await expect(namespaceOption).toBeChecked()

  if (fixtureMode === "live") {
    await page.keyboard.press("Escape")
    await expect(namespaceDialog).toBeHidden()
    await fleetMapOracle.drain()
    expect(
      fleetMapOracle.captures.slice(namespaceCaptureIndex).filter(
        (capture) => requestNamespaces(capture.request).length === 0,
      ),
      "live scope inspection must never issue an unscoped fleet-map request",
    ).toEqual([])
    await expectScopeInURL(page)
    return
  }

  runtimeAudit.allowUnscopedQueryOnce(QUERY_FLEET_MAP_PATH)
  const captureIndex = fleetMapOracle.captures.length
  await namespaceOption.focus()
  await page.keyboard.press("Space")
  await expect.poll(() => new URL(page.url()).searchParams.getAll("namespace")).toEqual([])
  await expect(namespaceOption).not.toBeChecked()
  await expect.poll(
    () => fleetMapOracle.captures.slice(captureIndex).some(
      (capture) => requestNamespaces(capture.request).length === 0,
    ),
    { message: "deselecting Namespace must issue an intentionally unscoped fleet request" },
  ).toBe(true)
  const unscoped = fleetMapOracle.captures.slice(captureIndex).find(
    (capture) => requestNamespaces(capture.request).length === 0,
  )
  expect(unscoped).toBeDefined()
  await runtimeAudit.assertUnscopedQueryAllowanceConsumed(QUERY_FLEET_MAP_PATH)
  const heatmap = page.getByRole("application", { name: "Fleet health heatmap" })
  await expect(heatmap).toHaveAttribute("data-heatmap-layout-digest", unscoped!.digest)
  await expect(heatmap).toHaveAttribute(
    "data-heatmap-input-count",
    String(unscoped!.stableIds.length),
  )
  await namespaceOption.focus()
  await page.keyboard.press("Space")
  await expectScopeInURL(page)
  await expect(namespaceOption).toBeChecked()
  const restored = await expectCompleteHeatmap(
    page,
    fleetMapOracle,
    expectedCount,
  )
  assertExactFleetMap(restored.capture, exactFleet)
  await page.keyboard.press("Escape")
  await expect(namespaceDialog).toBeHidden()
  await expectScopeInURL(page)
}

async function deselectNamespaceOption(page: Page, oracle: FleetMapOracle) {
  const namespaceTrigger = page.getByRole("button", { name: /^Namespaces,/u })
  await namespaceTrigger.click()
  const dialog = page.getByRole("dialog", { name: "Choose Namespaces" })
  await dialog.getByRole("searchbox").fill(runNamespace)
  const option = dialog.locator("label").filter({ hasText: runNamespace })
    .getByRole("checkbox")
  await expect(option).toBeChecked()
  const captureIndex = oracle.captures.length
  await option.focus()
  await page.keyboard.press("Space")
  await expect.poll(() => new URL(page.url()).searchParams.getAll("namespace")).toEqual([])
  await expect(option).not.toBeChecked()
  await expect.poll(
    () => oracle.captures.slice(captureIndex).some(
      (capture) => requestNamespaces(capture.request).length === 0,
    ),
    { message: "Namespace deselection must receive an unscoped QueryFleetMap response" },
  ).toBe(true)
  return { dialog, option }
}

async function issueUnscopedFleetMapQuery(page: Page) {
  await page.evaluate(async (path) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filter: { namespaces: [] } }),
    })
    if (!response.ok) {
      throw new Error(`unscoped QueryFleetMap failed with ${response.status}`)
    }
    await response.json()
  }, QUERY_FLEET_MAP_PATH)
}

function expectedNamespacedKey(value: string) {
  const separator = value.indexOf("/")
  const namespace = value.slice(0, separator)
  const name = value.slice(separator + 1)
  if (separator <= 0 || namespace !== runNamespace || name.length === 0) {
    throw new Error(
      `expected run-namespaced scope key ${runNamespace}/<name>, received ${value}`,
    )
  }
  return { namespace, name }
}

function isExactSelectedScopeRequest(
  capture: FleetMapCapture,
  selectedField: "projects" | "clusters" | "stages",
  selectedValue: { namespace: string; name: string } | string,
) {
  if (JSON.stringify(requestNamespaces(capture.request)) !== JSON.stringify([runNamespace])) {
    return false
  }
  const filter = requestFilter(capture.request)
  if (!filter) return false
  for (const field of ["projects", "clusters", "stages"] as const) {
    const actual = normalizedFilterEntries(filter[field], field)
    const expected = field === selectedField ? [selectedValue] : []
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false
  }
  return true
}

function requestFilter(request: Record<string, unknown>) {
  const filter = request.filter
  return filter && typeof filter === "object" && !Array.isArray(filter)
    ? filter as Record<string, unknown>
    : undefined
}

function normalizedFilterEntries(
  value: unknown,
  field: "projects" | "clusters" | "stages",
) {
  if (!Array.isArray(value)) return []
  if (field === "stages") return value
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    const object = entry as Record<string, unknown>
    return { namespace: object.namespace, name: object.name }
  })
}

async function expectRenderedFleetMapCapture(page: Page, capture: FleetMapCapture) {
  const heatmap = page.getByRole("application", { name: "Fleet health heatmap" })
  await expect(heatmap).toHaveAttribute("data-heatmap-layout-digest", capture.digest)
  await expect(heatmap).toHaveAttribute(
    "data-heatmap-input-count",
    String(capture.stableIds.length),
  )
}

async function assertCompleteHeatmapInteraction(page: Page, host: Locator) {
  await host.scrollIntoViewIfNeeded()
  const hostBox = await host.boundingBox()
  expect(hostBox).not.toBeNull()
  assertBoxInViewport(page, hostBox!, "heatmap controller")

  await host.hover({ position: { x: 6, y: 26 } })
  const tooltip = page.getByRole("tooltip", { name: "Application health details" })
  await expect(tooltip).toBeVisible()
  const tooltipBox = await tooltip.boundingBox()
  expect(tooltipBox).not.toBeNull()
  assertBoxInViewport(page, tooltipBox!, "heatmap tooltip")

  await host.focus()
  await page.keyboard.press("Home")
  await expect(page.getByRole("status", { name: "Active heatmap application" }))
    .not.toContainText("No application selected")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("status", { name: "Active heatmap application" }))
    .toContainText("No application selected")
}

async function assertPresentationGeometry(
  page: Page,
  presentation: "heatmap" | "treemap" | "matrix" | "table" | "queue",
) {
  const representative = presentation === "heatmap"
    ? page.getByRole("application", { name: "Fleet health heatmap" })
    : presentation === "treemap"
      ? page.getByRole("application", { name: "Fleet treemap" })
      : presentation === "matrix"
        ? page.getByRole("table", { name: "Fleet matrix" }).getByRole("row").nth(1)
        : presentation === "table"
          ? page.getByRole("table", { name: "Applications" }).getByRole("row").nth(1)
          : page.getByRole("region", { name: "Attention queue" })
            .getByRole("listitem").first()
  await representative.scrollIntoViewIfNeeded()
  await expect(
    representative,
    `${presentation} needs a representative accepted cell or surface`,
  ).toBeVisible()
  const box = await representative.boundingBox()
  expect(box, `${presentation} representative geometry`).not.toBeNull()
  assertBoxInViewport(page, box!, `${presentation} representative cell or surface`)
}

async function openFocusedHeatmapApplication(page: Page, host: Locator) {
  await host.focus()
  await page.keyboard.press("Home")
  const active = page.getByRole("status", { name: "Active heatmap application" })
  const name = (await active.locator("strong").innerText()).trim()
  expect(
    expectedStableIds,
    `active heatmap status must expose a ${runNamespace} Application identity`,
  ).toContain(`a:${runNamespace}/${name}`)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/dashboard\/application/u)
  return name
}

async function assertAdminSession(page: Page) {
  const banner = page.getByRole("status", {
    name: "Kubernetes port-forward admin session",
  })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(
    "Kubernetes port-forward admin session · unrestricted Paprika access",
  )
  await expect(banner).toContainText(`Reviewed Kubernetes subject: ${reviewedSubject}`)
}

async function assertViewportRoute(page: Page, description: string) {
  await page.waitForLoadState("networkidle")
  const documentWidth = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }))
  expect(
    documentWidth.scroll - documentWidth.client,
    `${description} must not introduce document-level horizontal overflow`,
  ).toBeLessThanOrEqual(1)

  const critical = page.locator(
    'main a:visible, main button:not(:disabled):visible, main input:visible, ' +
      'main select:visible, main [role="application"]:visible',
  ).first()
  await critical.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" })
  })
  await critical.focus()
  await expect(critical, `${description} critical control must accept keyboard focus`).toBeFocused()
  const criticalBox = await critical.boundingBox()
  expect(criticalBox, `${description} critical control geometry`).not.toBeNull()
  assertBoxInViewport(page, criticalBox!, `${description} critical control`)

  const banner = page.locator("[data-admin-session-banner]")
  const bannerBox = await banner.boundingBox()
  expect(bannerBox, `${description} admin banner geometry`).not.toBeNull()
  expect(
    boxesIntersect(criticalBox!, bannerBox!),
    `${description} admin banner must not cover the critical control; ` +
      `critical=${JSON.stringify(criticalBox)} banner=${JSON.stringify(bannerBox)}`,
  ).toBe(false)
}

function assertBoxInViewport(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  description: string,
) {
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(box.x, `${description} left edge`).toBeGreaterThanOrEqual(-1)
  expect(box.y, `${description} top edge`).toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width, `${description} right edge`).toBeLessThanOrEqual(viewport!.width + 1)
  expect(box.y + box.height, `${description} bottom edge`).toBeLessThanOrEqual(viewport!.height + 1)
}

function boxesIntersect(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
}

async function expectScopeInURL(page: Page) {
  await expect.poll(() => new URL(page.url()).searchParams.getAll("namespace"))
    .toEqual([runNamespace])
}

async function expectScopeInHref(locator: Locator) {
  const href = await locator.getAttribute("href")
  expect(href).not.toBeNull()
  expect(new URL(href!, "http://paprika.invalid").searchParams.getAll("namespace"))
    .toEqual([runNamespace])
}

async function attachView(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  })
}

async function navigateToScopedResponse(
  page: Page,
  path: string,
  destination: string,
) {
  const responsePromise = page.waitForResponse((response) => {
    if (!response.ok() || new URL(response.url()).pathname !== path) return false
    const request = requestBody(response.request().postDataJSON())
    if (path.includes("/Query")) {
      return requestNamespaces(request).length === 1 &&
        requestNamespaces(request)[0] === runNamespace
    }
    return request.namespace === runNamespace
  })
  await page.goto(destination)
  return await (await responsePromise).json() as Record<string, unknown>
}

function assertExactReleases(body: Record<string, unknown>) {
  const releases = wireCollection(body.releases).map((release) => ({
    namespace: wireString(release, "namespace"),
    name: wireString(release, "name"),
    phase: wireString(release, "phase"),
    application: wireString(release, "application"),
    rolloutRef: wireString(release, "rolloutRef"),
  })).sort(byName)
  expect(decimalWireCount(body.totalCount), "exact release response total").toBe(
    expectedDelivery.releases.length,
  )
  expect(releases, "exact release names, phases, Application and Rollout associations")
    .toEqual([...expectedDelivery.releases].sort(byName))
}

function assertExactRollouts(body: Record<string, unknown>) {
  const rollouts = wireCollection(body.rollouts).map((rollout) => ({
    namespace: wireString(rollout, "namespace"),
    name: wireString(rollout, "name"),
    phase: wireString(rollout, "phase"),
  })).sort(byName)
  expect(rollouts, "exact Rollout names and phases")
    .toEqual([...expectedDelivery.rollouts].sort(byName))
}

function assertExactPipelines(body: Record<string, unknown>) {
  const pipelines = wireCollection(body.pipelines).map((pipeline) => ({
    namespace: wireString(pipeline, "namespace"),
    name: wireString(pipeline, "name"),
    phase: wireString(pipeline, "phase"),
    project: wireString(pipeline, "project"),
  })).sort(byName)
  expect(pipelines, "exact Pipeline names, phases, and Project associations")
    .toEqual([...expectedDelivery.pipelines].sort(byName))
}

async function assertRenderedReleases(page: Page) {
  const list = page.getByRole("list", { name: "Releases" })
  await expect(list.getByRole("listitem"), "rendered Release count")
    .toHaveCount(expectedDelivery.releases.length)
  for (const release of expectedDelivery.releases) {
    const article = list.getByRole("article", { name: release.name, exact: true })
    await expect(article, `rendered Release ${release.name}`).toBeVisible()
    await expect(article).toContainText(release.phase)
    await expect(article).toContainText(`${release.namespace}/${release.name}`)
    await expect(
      article.getByRole("link", { name: `Open application ${release.application}` }),
      `rendered Release ${release.name} Application association`,
    ).toBeVisible()
    await expect(
      article.getByRole("link", { name: `Open rollout ${release.rolloutRef}` }),
      `rendered Release ${release.name} Rollout association`,
    ).toBeVisible()
  }
}

async function assertRenderedRollouts(page: Page) {
  const table = page.getByRole("table")
  await expect(table.getByRole("row"), "rendered Rollout count plus header")
    .toHaveCount(expectedDelivery.rollouts.length + 1)
  for (const rollout of expectedDelivery.rollouts) {
    const row = table.getByRole("row").filter({ hasText: rollout.name })
    await expect(row, `rendered Rollout ${rollout.name}`).toHaveCount(1)
    await expect(row).toContainText(rollout.phase)
    await expect(row).toContainText(rollout.namespace)
  }
}

async function assertRenderedPipelines(section: Locator) {
  const links = section.getByRole("link", { name: /^Open pipeline /u })
  await expect(links, "rendered Pipeline count").toHaveCount(expectedDelivery.pipelines.length)
  for (const pipeline of expectedDelivery.pipelines) {
    const link = section.getByRole("link", {
      name: `Open pipeline ${pipeline.name}`,
      exact: true,
    })
    await expect(link, `rendered Pipeline ${pipeline.name}`).toBeVisible()
    const headingRow = link.locator("..")
    await expect(headingRow).toContainText(pipeline.phase)
    await expect(headingRow).toContainText(`ns/${pipeline.namespace}`)
  }
}

function expectedDeliveryFixture() {
  if (fixtureMode === "live") {
    return {
      releases: [
        release("billing-gated", "AwaitingApproval", "billing", "billing-gated-rollout"),
        release("catalog-active", "Failed", "catalog", "catalog-active-rollout"),
        release("checkout-complete", "Complete", "checkout", "checkout-complete-rollout"),
        release("ledger-failed", "Failed", "ledger", "ledger-failed-rollout"),
      ],
      rollouts: [
        rollout("billing-gated-rollout", "Paused"),
        rollout("catalog-active-rollout", "Progressing"),
        rollout("checkout-complete-rollout", "Healthy"),
        rollout("ledger-failed-rollout", "Failed"),
      ],
      pipelines: [
        pipeline("finance-ci", "Failed", "finance"),
        pipeline("storefront-ci", "Succeeded", "storefront"),
      ],
    }
  }

  const states = [
    { release: "Complete", rollout: "Healthy", pipeline: "Succeeded", project: "payments" },
    { release: "Failed", rollout: "Degraded", pipeline: "Failed", project: "commerce" },
    { release: "Complete", rollout: "Healthy", pipeline: "Succeeded", project: "fulfillment" },
    { release: "Promoting", rollout: "Progressing", pipeline: "Running", project: "platform" },
    {
      release: "AwaitingApproval",
      rollout: "Paused",
      pipeline: "Running",
      project: "governance",
    },
    { release: "Failed", rollout: "Failed", pipeline: "Failed", project: "security" },
    { release: "Pending", rollout: "Pending", pipeline: "Running", project: "insights" },
    { release: "Complete", rollout: "Healthy", pipeline: "Succeeded", project: "commerce" },
  ] as const
  const releases = []
  const rollouts = []
  const pipelines = []
  for (const stableId of expectedStableIds) {
    const name = stableId.slice(stableId.indexOf("/") + 1)
    const index = name === "checkout-service"
      ? 0
      : Number(name.slice("application-".length))
    const state = states[index % states.length]
    releases.push(
      release(`${name}-release-v1`, state.release, name, `${name}-rollout-v1`),
    )
    rollouts.push(rollout(`${name}-rollout-v1`, state.rollout))
    pipelines.push(pipeline(`${name}-pipeline`, state.pipeline, state.project))
  }
  return { releases, rollouts, pipelines }

  function release(name: string, phase: string, application: string, rolloutRef: string) {
    return { namespace: runNamespace, name, phase, application, rolloutRef }
  }

  function rollout(name: string, phase: string) {
    return { namespace: runNamespace, name, phase }
  }

  function pipeline(name: string, phase: string, project: string) {
    return { namespace: runNamespace, name, phase, project }
  }
}

function requestBody(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function wireCollection(value: unknown) {
  return Array.isArray(value)
    ? value.map(requestBody)
    : []
}

function wireString(value: Record<string, unknown>, field: string) {
  return typeof value[field] === "string" ? value[field] : ""
}

function decimalWireCount(value: unknown) {
  const count = typeof value === "string" || typeof value === "number"
    ? Number(value)
    : Number.NaN
  expect(Number.isSafeInteger(count) && count >= 0, "wire count must be a non-negative integer")
    .toBe(true)
  return count
}

function byName<T extends { name: string }>(left: T, right: T) {
  return left.name.localeCompare(right.name)
}

function expectedApplicationStableIds(namespace: string) {
  const supplied = process.env.PAPRIKA_E2E_EXPECTED_APPLICATION_IDS
  if (supplied !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(supplied)
    } catch {
      throw new Error("PAPRIKA_E2E_EXPECTED_APPLICATION_IDS must be a JSON string array")
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((value) =>
        typeof value !== "string" ||
        !value.startsWith(`a:${namespace}/`) ||
        !/^a:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\/[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u
          .test(value)
      )
    ) {
      throw new Error(
        "PAPRIKA_E2E_EXPECTED_APPLICATION_IDS must contain only exact run-namespace stable IDs",
      )
    }
    if (new Set(parsed).size !== parsed.length) {
      throw new Error("PAPRIKA_E2E_EXPECTED_APPLICATION_IDS contains duplicate identities")
    }
    return [...parsed].sort()
  }

  const match = /^team-(\d{2})$/u.exec(namespace)
  if (!match) {
    throw new Error(
      "PAPRIKA_E2E_EXPECTED_APPLICATION_IDS is required outside the deterministic local fixture",
    )
  }
  const namespaceIndex = Number(match[1])
  if (namespaceIndex > 11) {
    throw new Error(`local fixture namespace ${namespace} is outside team-00 through team-11`)
  }
  const applicationCount =
    optionalPositiveInteger(
      "PAPRIKA_E2E_APPLICATIONS",
      process.env.PAPRIKA_E2E_APPLICATIONS,
    ) ?? 250
  const stableIds: string[] = []
  for (let index = namespaceIndex; index < applicationCount; index += 12) {
    const name = index === 0 ? "checkout-service" : `application-${String(index).padStart(5, "0")}`
    stableIds.push(`a:${namespace}/${name}`)
  }
  return stableIds.sort()
}

function optionalPositiveInteger(name: string, raw: string | undefined) {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name} must be a positive integer no larger than 100000`)
  }
  return value
}

function requiredDNSLabel(name: string, value: string) {
  if (
    value.length > 63 ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(value)
  ) {
    throw new Error(`${name} must be a DNS1123 label`)
  }
  return value
}
