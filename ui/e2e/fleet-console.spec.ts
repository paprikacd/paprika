import {
  expect,
  test as base,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

import { installRuntimeAudit, type RuntimeAudit } from "./helpers/runtime-audit"
import {
  QUERY_FLEET_MAP_PATH,
  expectCompleteHeatmap,
  observeFleetMapResponses,
  type FleetMapOracle,
  type WireFleetMapNode,
} from "./helpers/fleet-map-oracle"

const baseURL = process.env.PAPRIKA_E2E_BASE_URL ?? "http://127.0.0.1:3100"
const keyboardProject = "chromium-keyboard-only"
const projectKey = "team-00/payments"
const fuzzyApplication = "team-00/checkout-service"
const dashboardRedirectRequestFanout = 8

type RuntimeAuditFixtures = {
  runtimeAudit: RuntimeAudit
  fleetMapOracle: FleetMapOracle
}

const test = base.extend<RuntimeAuditFixtures>({
  runtimeAudit: [
    async ({ page }, use) => {
      const audit = installRuntimeAudit(page)
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
    { auto: false },
  ],
})

test("uses the externally supplied Playwright base URL", async ({}, testInfo) => {
  expect(testInfo.project.use.baseURL).toBe(baseURL)
})

test("renders every Application in the independently verified health heatmap", async ({
  page,
  fleetMapOracle: oracle,
}) => {
  await page.goto(
    "/dashboard/applications?view=heatmap&group=namespace&density=compact&labels=none&sort=health&direction=desc",
  )

  const verified = await expectCompleteHeatmap(page, oracle, 250)
  await expect(verified.host.locator("canvas")).toHaveCount(1)
  await verified.host.hover({ position: { x: 6, y: 26 } })
  await expect(page.getByRole("tooltip", { name: "Application health details" })).toBeVisible()

  await verified.host.focus()
  await page.keyboard.press("Home")
  const first = await page.getByRole("status", { name: "Active heatmap application" }).innerText()
  await page.keyboard.press("ArrowRight")
  await expect
    .poll(() => page.getByRole("status", { name: "Active heatmap application" }).innerText())
    .not.toBe(first)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("status", { name: "Active heatmap application" }))
    .toContainText("No application selected")
})

test("applies Project, Cluster, Stage, and Namespace scope to every heatmap leaf", async ({
  page,
  fleetMapOracle: oracle,
}) => {
  const cases: ReadonlyArray<{
    dimension: "project" | "cluster" | "stage" | "namespace"
    plural: "Projects" | "Clusters" | "Stages" | "Namespaces"
    search: string
    option: RegExp
    value: string
    description: string
    matches: (leaf: WireFleetMapNode) => boolean
  }> = [
    {
      dimension: "project",
      plural: "Projects",
      search: "team-00/payments",
      option: /^Projects, Payments, team-00\/payments, .*not selected$/iu,
      value: "team-00/payments",
      description: "Project team-00/payments",
      matches: (leaf) =>
        leaf.applicationMetadata?.project?.namespace === "team-00" &&
        leaf.applicationMetadata.project.name === "payments",
    },
    {
      dimension: "cluster",
      plural: "Clusters",
      search: "team-01/delivery-unhealthy",
      option: /^Clusters, .*team-01\/delivery-unhealthy, .*not selected$/iu,
      value: "team-01/delivery-unhealthy",
      description: "Cluster team-01/delivery-unhealthy",
      matches: (leaf) =>
        leaf.applicationMetadata?.currentCluster?.namespace === "team-01" &&
        leaf.applicationMetadata.currentCluster.name === "delivery-unhealthy",
    },
    {
      dimension: "stage",
      plural: "Stages",
      search: "staging",
      option: /^Stages, staging, .*not selected$/iu,
      value: "staging",
      description: "Stage staging",
      matches: (leaf) => leaf.applicationMetadata?.currentStage === "staging",
    },
    {
      dimension: "namespace",
      plural: "Namespaces",
      search: "team-02",
      option: /^Namespaces, team-02, .*not selected$/iu,
      value: "team-02",
      description: "Namespace team-02",
      matches: (leaf) => leaf.application?.namespace === "team-02",
    },
  ]

  await page.goto("/dashboard/applications?view=heatmap&group=namespace")
  await expectCompleteHeatmap(page, oracle, 250)
  for (const scope of cases) {
    await page.getByRole("button", {
      name: new RegExp(`^${scope.plural}, All ${scope.plural.toLocaleLowerCase()},`),
    }).click()
    const chooser = page.getByRole("dialog", { name: `Choose ${scope.plural}` })
    await chooser.getByRole("searchbox").fill(scope.search)
    await chooser.getByRole("checkbox", { name: scope.option }).click()
    await page.keyboard.press("Escape")
    await expect.poll(() => queryValues(page, scope.dimension)).toEqual([scope.value])

    const verified = await expectCompleteHeatmap(page, oracle)
    expect(verified.capture.total, `${scope.description} must be non-empty`).toBeGreaterThan(0)
    expect(verified.capture.total, `${scope.description} must narrow the 250-Application fleet`)
      .toBeLessThan(250)
    expect(
      verified.capture.leaves.every(scope.matches),
      `every intercepted heatmap leaf must belong to ${scope.description}`,
    ).toBe(true)

    await page.reload()
    await expect.poll(() => queryValues(page, scope.dimension)).toEqual([scope.value])
    const persisted = await expectCompleteHeatmap(page, oracle)
    expect(persisted.capture.leaves.every(scope.matches),
      `${scope.description} membership must survive reload`).toBe(true)

    await expect(page.getByRole("button", { name: new RegExp(`^${scope.plural},`) }))
      .not.toHaveAttribute("aria-busy", "true")
    await page.getByRole("button", { name: "Clear fleet scope" }).click()
    await expect.poll(() => queryValues(page, scope.dimension)).toEqual([])
    await expectCompleteHeatmap(page, oracle, 250)
  }
})

test("preserves scope, search, filters, and display options across all five presentations", async ({
  page,
}, testInfo) => {
  const retained = {
    project: projectKey,
    health: "healthy",
    q: "checkout service",
    group: "namespace",
    density: "compact",
    labels: "all",
    sort: "health",
    direction: "desc",
  }
  await page.goto(`/dashboard/applications?${new URLSearchParams({ view: "heatmap", ...retained })}`)
  await expect(page.locator('[data-fleet-ready="1"]')).toBeVisible()

  const presentations = ["heatmap", "treemap", "matrix", "table", "queue"] as const
  for (const view of presentations) {
    await activate(page, page.getByRole("button", { name: `Show ${titleCase(view)} view` }), testInfo)
    await expect(page.getByRole("button", { name: `Show ${titleCase(view)} view` }))
      .toHaveAttribute("aria-pressed", "true")
    await expectQueryState(page, {
      ...retained,
      view: view === "treemap" ? null : view,
    })

    if (view === "heatmap") {
      await expect(page.getByRole("application", { name: "Fleet health heatmap" })).toBeVisible()
    } else if (view === "treemap") {
      await expect(page.getByRole("application", { name: "Fleet treemap" })).toBeVisible()
      await page.getByRole("combobox", { name: "Size applications by" }).selectOption("request_rate")
      await expect.poll(() => queryValue(page, "size")).toBe("request_rate")
    } else if (view === "matrix") {
      await expect(page.getByRole("table", { name: "Fleet matrix" })).toBeVisible()
      await page.getByRole("combobox", { name: "Matrix rows" }).selectOption("namespace")
      await page.getByRole("combobox", { name: "Matrix columns" }).selectOption("health")
      await expect.poll(() => queryValue(page, "rows")).toBe("namespace")
      await expect.poll(() => queryValue(page, "columns")).toBe("health")
    } else if (view === "table") {
      await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
    } else {
      await expect(page.getByRole("region", { name: "Attention queue" })).toBeVisible()
    }
  }

  await activate(page, page.getByRole("button", { name: "Show Heatmap view" }), testInfo)
  await page.getByRole("combobox", { name: "Group heatmap by" }).selectOption("health")
  await page.getByRole("combobox", { name: "Heatmap density" }).selectOption("comfortable")
  await page.getByRole("combobox", { name: "Heatmap labels" }).selectOption("none")
  await page.getByRole("combobox", { name: "Sort applications by" }).selectOption("name")
  await page.getByRole("combobox", { name: "Sort direction" }).selectOption("asc")
  await expect(page.getByRole("combobox", { name: "Sort applications by" })).toHaveValue("name")
  await expect(page.getByRole("combobox", { name: "Sort direction" })).toHaveValue("asc")
  await expectQueryState(page, {
    ...retained,
    view: "heatmap",
    group: "health",
    density: "comfortable",
    labels: "none",
    sort: "name",
    direction: "asc",
  })
})

test("reorders all five presentations through the visible sort controls", async ({ page }) => {
  for (const view of ["heatmap", "treemap", "matrix", "table", "queue"] as const) {
    const ascending = await firstPresentationLabel(page, view, "asc")
    const descending = await firstPresentationLabel(page, view, "desc")
    expect(descending, `${view} descending order must differ from ascending`).not.toBe(ascending)
    expect(
      descending.localeCompare(ascending),
      `${view} must apply descending name order to its rendered presentation`,
    ).toBeGreaterThan(0)
  }
})

test("keeps loading provenance visible until the complete map arrives", async ({
  page,
  fleetMapOracle: oracle,
}) => {
  let releaseResponse: (() => void) | undefined
  let held = false
  await page.route(`**${QUERY_FLEET_MAP_PATH}`, async (route) => {
    const request = route.request().postDataJSON() as { group?: string }
    if (!held && request.group === "FLEET_GROUP_DIMENSION_HEALTH") {
      held = true
      await new Promise<void>((resolve) => {
        releaseResponse = resolve
      })
    }
    await route.continue()
  })
  await page.goto("/dashboard/")
  await expect(page.getByRole("status", { name: "Loading complete application health map" }))
    .toBeVisible()
  await expect.poll(() => typeof releaseResponse).toBe("function")
  releaseResponse!()
  await expectCompleteHeatmap(page, oracle, 250)
})

test("keeps map failure actionable, retries, and exposes empty-scope recovery", async ({
  page,
  runtimeAudit,
  fleetMapOracle: oracle,
}) => {
  runtimeAudit.allowConnectFailure(QUERY_FLEET_MAP_PATH, 503, 3)
  runtimeAudit.allowConsoleError(/Failed to load resource: the server responded with a status of 503/u, 3)
  let failures = 0
  await page.route(`**${QUERY_FLEET_MAP_PATH}`, async (route) => {
    const request = route.request().postDataJSON() as { group?: string }
    if (failures < 3 && request.group === "FLEET_GROUP_DIMENSION_HEALTH") {
      failures += 1
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "unavailable", message: "intentional map failure" }),
      })
      return
    }
    await route.continue()
  })
  await page.goto("/dashboard/?namespace=team-00")
  const alert = page.getByRole("alert", { name: "Application health map unavailable" })
  await expect(alert).toBeVisible()
  const tableFallback = alert.getByRole("link", { name: "Open complete Table view" })
  await expect(tableFallback).toHaveAttribute("href", /namespace=team-00/u)
  await alert.getByRole("button", { name: "Retry application health map" }).click()
  const recovered = await expectCompleteHeatmap(page, oracle)
  expect(recovered.capture.total).toBeGreaterThan(0)

  await page.goto("/dashboard/?namespace=fixture-empty-namespace")
  await expect(page.getByText("No applications match this fleet scope", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Clear fleet scope" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Open complete Table view" })).toHaveAttribute(
    "href",
    /namespace=fixture-empty-namespace/u,
  )
})

test("retains fleet scope through every inventory and four detail/back routes", async ({ page }) => {
  const scope = new URLSearchParams({
    project: "team-04/payments",
    cluster: "team-04/delivery-primary",
    stage: "production",
    namespace: "team-04",
  })
  await page.goto(`/dashboard/applications?view=table&${scope}`)
  await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
  await page.waitForLoadState("networkidle")

  for (const section of ["Overview", "Applications", "Releases", "Rollouts", "Pipelines"] as const) {
    const link = page.getByRole("navigation", { name: "Fleet sections" })
      .getByRole("link", { name: section, exact: true })
    await expectScopeInHref(link, scope)
    await link.click()
    await expectScopeInURL(page, scope)
    await expectFleetSectionSettled(page, section)
  }

  const details = [
    {
      path: "/dashboard/application",
      identity: { application_namespace: "team-04", application_name: "application-00004" },
      heading: "application-00004",
      back: "Dashboard",
    },
    {
      path: "/dashboard/applicationsets/detail",
      identity: {
        applicationset_namespace: "team-04",
        applicationset_name: "fixture-applications",
      },
      heading: "fixture-applications",
      back: "Application Sets",
    },
    {
      path: "/dashboard/rollouts/detail",
      identity: { rollout_namespace: "team-04", rollout_name: "application-00004-rollout-v1" },
      heading: "application-00004-rollout-v1",
      back: "Rollouts",
    },
    {
      path: "/dashboard/pipelines/detail",
      identity: { pipeline_namespace: "team-04", pipeline_name: "application-00004-pipeline" },
      heading: "application-00004-pipeline",
      back: "Back to Dashboard",
    },
  ] as const

  for (const detail of details) {
    const parameters = new URLSearchParams(scope)
    for (const [key, value] of Object.entries(detail.identity)) parameters.set(key, value)
    await page.goto(`${detail.path}?${parameters}`)
    await expect(page.getByRole("heading", { level: 1, name: detail.heading })).toBeVisible()
    await page.waitForLoadState("networkidle")
    await expectScopeInURL(page, scope)
    const back = page.getByRole(detail.back === "Back to Dashboard" ? "button" : "link", {
      name: detail.back,
      exact: true,
    }).first()
    if (detail.back !== "Back to Dashboard") await expectScopeInHref(back, scope)
    await back.click()
    await expectScopeInURL(page, scope)
    if (detail.back === "Application Sets") {
      await expect(page.getByRole("heading", { level: 1, name: "Application Sets" })).toBeVisible()
      await expect(page.locator("main .animate-pulse")).toHaveCount(0)
      await page.waitForLoadState("networkidle")
    } else if (detail.back === "Rollouts") {
      await expectFleetSectionSettled(page, "Rollouts")
    } else {
      await expectFleetSectionSettled(page, "Overview")
    }
  }
})

test("serves the compiled shell with exact links and disabled placeholders", async ({ page }) => {
  await page.goto("/dashboard/applications")

  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
  const navigation = page.getByRole("navigation", { name: "Fleet sections" })
  const expectedLinks = [
    ["Overview", "/dashboard/"],
    ["Applications", "/dashboard/applications/"],
    ["Pipelines", "/dashboard/#pipelines"],
    ["Releases", "/dashboard/releases/"],
    ["Rollouts", "/dashboard/rollouts/"],
  ] as const

  for (const [name, href] of expectedLinks) {
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute("href", href)
  }

  for (const name of ["Activity", "Admin"] as const) {
    const placeholder = navigation.getByRole("button", {
      name: new RegExp(`^${name}\\. Available in a later plan$`, "i"),
    })
    await expect(placeholder).toBeDisabled()
    await expect(placeholder).toHaveAttribute("aria-disabled", "true")
    await expect(placeholder).toHaveAttribute("title", "Available in a later plan")
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveCount(0)
  }
})

test("loads empty policies through the real fixture", async ({ page }) => {
  const policyResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      "/paprika.v1.PaprikaService/ListPolicies",
  )

  await page.goto("/dashboard/")

  const response = await policyResponse
  const body = await response.json()
  expect(response.status(), `ListPolicies response: ${JSON.stringify(body)}`).toBe(200)
  expect(body).toEqual({})
  await expect(page.getByText("No policies yet", { exact: true })).toBeVisible()
  await expect(page.getByText(/failed to load policies/i)).toHaveCount(0)
})

test("keeps the focused skip link fixed and operable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto("/dashboard/")

  const skipLink = page.getByRole("link", { name: "Skip to fleet content" })
  await page.keyboard.press("Tab")
  await expect(skipLink).toBeFocused()
  await expect(skipLink).toBeVisible()
  await expect(skipLink).toHaveCSS("position", "fixed")
  await expect(skipLink).toHaveCSS("clip-path", "inset(0px)")

  const box = await skipLink.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  )
  expect(box!.y + box!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  )

  await page.keyboard.press("Enter")
  const main = page.locator("#dashboard-main")
  await expect(main).toBeFocused()
  const outline = await main.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    }
  })
  expect(outline.style).toBe("solid")
  expect(outline.width).toBeGreaterThanOrEqual(2)
  expect(outline.color).not.toBe("transparent")
  expect(outline.color).not.toBe("rgba(0, 0, 0, 0)")
})

test("applies a namespaced project facet and typo-tolerant application search", async ({
  page,
}, testInfo) => {
  await page.goto("/dashboard/applications?view=table")
  await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()

  const scope = page.getByRole("region", { name: "Current fleet scope" })
  await activate(page, scope.getByRole("button", { name: /^Projects,/u }), testInfo)
  const projectFilter = page.getByRole("checkbox", {
    name: new RegExp(`^Projects, payments, ${projectKey.replace("/", "\\/")},`, "i"),
  })
  await activate(page, projectFilter, testInfo, "Space")
  await expect.poll(() => queryValues(page, "project")).toEqual([projectKey])
  await page.keyboard.press("Escape")

  const search = page.getByRole("searchbox", { name: "Search applications" })
  await enterText(page, search, "checkout servce", testInfo)
  await expect.poll(() => queryValue(page, "q")).toBe("checkout servce")

  await expect(page.getByRole("row", { name: fuzzyApplication })).toBeVisible()
  await expect(page.getByTestId("fleet-load-more-sentinel")).toContainText(
    "1 loaded / 1 indexed",
  )
})

test("preserves URL state through Treemap, Matrix, and Table with keyboard selection", async ({
  page,
}, testInfo) => {
  const initialQuery = new URLSearchParams({
    project: projectKey,
    health: "healthy",
    q: "checkout service",
  })
  await page.goto(`/dashboard/applications?${initialQuery.toString()}`)

  const treemap = page.getByRole("application", { name: "Fleet treemap" })
  await expect(treemap).toBeVisible()
  await expect(treemap).toHaveAttribute(
    "data-motion",
    testInfo.project.name === "chromium-reduced-motion" ? "reduced" : "enabled",
  )

  await tabTo(page, treemap)
  await page.keyboard.press("Home")
  await expect.poll(() => queryValue(page, "selected")).toBe(fuzzyApplication)

  const selected = queryValue(page, "selected")
  await activate(
    page,
    page.getByRole("button", { name: "Show Matrix view" }),
    testInfo,
  )
  await expect(page.getByRole("table", { name: "Fleet matrix" })).toBeVisible()
  await expectQueryState(page, {
    project: projectKey,
    health: "healthy",
    q: "checkout service",
    selected,
    view: "matrix",
  })

  await activate(
    page,
    page.getByRole("button", { name: "Show Table view" }),
    testInfo,
  )
  await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
  await expectQueryState(page, {
    project: projectKey,
    health: "healthy",
    q: "checkout service",
    selected,
    view: "table",
  })
  await expect(page.getByRole("row", { name: fuzzyApplication })).toBeVisible()
})

test("loads the next cursor page without replacing existing applications", async ({
  page,
}, testInfo) => {
  await page.goto("/dashboard/applications?view=table")

  const sentinel = page.getByTestId("fleet-load-more-sentinel")
  await expect(sentinel).toContainText("100 loaded / 250 indexed")
  await activate(
    page,
    page.getByRole("button", { name: "Load 100 more applications" }),
    testInfo,
  )
  await expect(sentinel).toContainText("200 loaded / 250 indexed")
})

test("opens a real Application deep link from highest-impact attention", async ({
  page,
}, testInfo) => {
  await page.goto("/dashboard")

  const attention = page.getByRole("region", { name: "Highest impact attention" })
  const applicationLink = attention.getByRole("listitem").first().getByRole("link")
  await expect(applicationLink).toBeVisible()
  const href = await applicationLink.getAttribute("href")
  expect(href).toBeTruthy()

  const destination = new URL(href!, baseURL)
  const applicationName = destination.searchParams.get("application_name")
  const namespace = destination.searchParams.get("application_namespace")
  expect(applicationName).toBeTruthy()
  expect(namespace).toBeTruthy()

  await activate(page, applicationLink, testInfo)
  await expect(page).toHaveURL(destination.toString())
  await expect(page.getByRole("heading", { level: 1, name: applicationName! })).toBeVisible()
  await expect(page.getByText("Current Phase", { exact: true })).toBeVisible()
  await expect(page.getByText("Application not found.", { exact: true })).toHaveCount(0)
})

test("discovers complete releases from command search and migrates legacy scope", async ({
  page,
  runtimeAudit,
}, testInfo) => {
  allowDashboardRedirectCancellations(runtimeAudit)
  const releaseName = "application-00246-release-v1"
  const releaseNamespace = "team-06"

  await page.goto("/dashboard/")
  await expect(
    page.getByRole("heading", { level: 2, name: "Cluster command center" }),
  ).toBeVisible()

  const search = page.getByRole("searchbox", { name: "Search operations" })
  await enterText(page, search, releaseName, testInfo)

  const releaseResult = page.getByRole("link", {
    name: new RegExp(`^Release ${releaseName}`),
  })
  await expect(releaseResult).toBeVisible()

  const href = await releaseResult.getAttribute("href")
  expect(href).toBeTruthy()
  const destination = new URL(href!, baseURL)
  expect(destination.pathname).toBe("/dashboard/releases/")
  expect(destination.searchParams.get("q")).toBe(releaseName)
  expect(destination.searchParams.get("namespace")).toBe(releaseNamespace)
  expect(destination.hash).toBe("")

  await page.waitForLoadState("networkidle")
  await activate(page, releaseResult, testInfo)
  await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
  await expect(page.getByText(releaseName, { exact: true })).toBeVisible()
  await expect.poll(() => releaseURLState(page)).toEqual({
    pathname: "/dashboard/releases/",
    project: null,
    cluster: null,
    stage: null,
    namespace: releaseNamespace,
    q: releaseName,
    hash: "",
  })

  const migrations: string[] = []
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return
    const url = new URL(frame.url())
    if (url.pathname === "/dashboard/releases/" && url.hash === "") {
      migrations.push(url.toString())
    }
  })

  await page.waitForLoadState("networkidle")
  await page.goto(
    "/dashboard/?project=team-06%2Fcommerce&cluster=team-06%2Fdelivery-unhealthy&stage=production&namespace=team-06#releases",
  )
  await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
  await expect.poll(() => releaseURLState(page)).toEqual({
    pathname: "/dashboard/releases/",
    project: "team-06/commerce",
    cluster: "team-06/delivery-unhealthy",
    stage: "production",
    namespace: releaseNamespace,
    q: null,
    hash: "",
  })
  expect(migrations).toHaveLength(1)
})

test("troubleshoots a Deployment from graph and list views using only the keyboard", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== keyboardProject, "keyboard-only coverage")

  await page.goto("/dashboard/application?namespace=team-00&name=checkout-service")
  await expect(
    page.getByRole("heading", { level: 1, name: "checkout-service" }),
  ).toBeVisible()
  await expect(page.getByText("Managed Resources", { exact: true })).toBeVisible()

  const resourceDetailsName = "Open Deployment checkout-service resource details"
  const graphDetailsButton = page.getByRole("button", { name: resourceDetailsName })
  await expect(graphDetailsButton).toBeVisible()
  await expect(graphDetailsButton).toHaveJSProperty("tagName", "BUTTON")
  await activate(page, graphDetailsButton, testInfo, "Enter")

  const resourceDetailsDialog = page.getByRole("dialog", {
    name: "Resource details for Deployment/checkout-service",
  })
  await expect(resourceDetailsDialog).toBeVisible()

  const investigateButton = resourceDetailsDialog.getByRole("button", {
    name: "Investigate",
    exact: true,
  })
  const investigationResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/paprika.v1.PaprikaService/Investigate" &&
    response.request().method() === "POST" && response.ok(),
  )
  await activate(page, investigateButton, testInfo, "Enter")
  await investigationResponse

  const investigationDialog = page.getByRole("dialog", {
    name: "Investigation for Deployment/checkout-service",
  })
  await expect(investigationDialog).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(investigationDialog).toBeHidden()
  await expect(investigateButton).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(resourceDetailsDialog).toBeHidden()
  await expect(graphDetailsButton).toBeFocused()

  await activate(page, page.getByRole("button", { name: "List", exact: true }), testInfo)
  const resourceTable = page.getByRole("table", { name: "Application resources" })
  await expect(resourceTable).toBeVisible()

  const listDetailsButton = resourceTable.getByRole("button", {
    name: resourceDetailsName,
  })
  await expect(listDetailsButton).toHaveJSProperty("tagName", "BUTTON")
  await tabTo(page, listDetailsButton)
  await expect(listDetailsButton).toBeFocused()
  await page.keyboard.press("Space")
  await expect(resourceDetailsDialog).toBeVisible()
})

test("redirects the legacy applications hash to the dedicated inventory", async ({
  page,
  runtimeAudit,
}) => {
  allowDashboardRedirectCancellations(runtimeAudit)
  await page.goto("/dashboard#applications")

  await expect(page).toHaveURL(`${baseURL}/dashboard/applications/`)
  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
})

async function activate(
  page: Page,
  target: Locator,
  testInfo: TestInfo,
  key: "Enter" | "Space" = "Enter",
) {
  const locator = target.first()
  await expect(locator).toBeVisible()
  if (testInfo.project.name !== keyboardProject) {
    await locator.click()
    return
  }

  await tabTo(page, locator)
  await page.keyboard.press(key)
}

async function enterText(page: Page, target: Locator, value: string, testInfo: TestInfo) {
  const locator = target.first()
  await expect(locator).toBeVisible()
  if (testInfo.project.name !== keyboardProject) {
    await locator.fill(value)
    return
  }

  await tabTo(page, locator)
  await page.keyboard.press("Control+A")
  await page.keyboard.type(value)
}

async function tabTo(page: Page, target: Locator) {
  const locator = target.first()
  await locator.scrollIntoViewIfNeeded()
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  throw new Error("keyboard navigation did not reach the requested control")
}

function queryValue(page: Page, key: string) {
  return new URL(page.url()).searchParams.get(key)
}

function queryValues(page: Page, key: string) {
  return new URL(page.url()).searchParams.getAll(key)
}

async function firstInventoryApplication(table: Locator) {
  const identity = await table.getByRole("row").nth(1).getAttribute("aria-label")
  expect(identity, "the first virtualized inventory row must expose its identity").toBeTruthy()
  return identity!
}

async function expectFleetSectionSettled(
  page: Page,
  section: "Overview" | "Applications" | "Releases" | "Rollouts" | "Pipelines",
) {
  if (section === "Overview") {
    await expect(
      page.getByRole("heading", { level: 2, name: "Cluster command center" }),
    ).toBeVisible()
  } else if (section === "Applications") {
    await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
    await expect(page.locator('[data-fleet-ready]')).toBeVisible()
  } else if (section === "Releases") {
    await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
    await expect(page.getByText("Loading releases…", { exact: true })).toHaveCount(0)
  } else if (section === "Rollouts") {
    await expect(page.getByRole("heading", { level: 1, name: "Rollouts" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
  } else {
    await expect(page.locator("#pipelines")).toBeVisible()
  }
  await expect(page.locator("main .animate-pulse")).toHaveCount(0)
  await page.waitForLoadState("networkidle")
}

async function firstPresentationLabel(
  page: Page,
  view: "heatmap" | "treemap" | "matrix" | "table" | "queue",
  direction: "asc" | "desc",
) {
  await page.goto(`/dashboard/applications?view=${view}&sort=name&direction=${direction}`)
  await expect(page.locator('[data-fleet-ready="250"]')).toBeVisible()
  const sortLabel = view === "matrix" ? "Sort intersections by" : "Sort applications by"
  await expect(page.getByRole("combobox", { name: sortLabel })).toHaveValue("name")
  await expect(page.getByRole("combobox", { name: "Sort direction" })).toHaveValue(direction)

  if (view === "heatmap") {
    const controller = page.getByRole("application", { name: "Fleet health heatmap" })
    await controller.focus()
    await page.keyboard.press("Home")
    return page.getByRole("status", { name: "Active heatmap application" })
      .locator("strong")
      .innerText()
  }
  if (view === "treemap") {
    const controller = page.getByRole("application", { name: "Fleet treemap" })
    await controller.focus()
    await page.keyboard.press("Home")
    await expect.poll(() => queryValue(page, "selected")).not.toBeNull()
    return applicationName(queryValue(page, "selected")!)
  }
  if (view === "matrix") {
    return page.getByRole("table", { name: "Fleet matrix" })
      .getByRole("row")
      .nth(1)
      .getByRole("rowheader")
      .locator("span")
      .first()
      .innerText()
  }
  if (view === "table") {
    return applicationName(
      await firstInventoryApplication(page.getByRole("table", { name: "Applications" })),
    )
  }

  const identity = await page.getByRole("region", { name: "Attention queue" })
    .getByRole("listitem")
    .first()
    .getAttribute("aria-label")
  expect(identity, "the first queue item must expose its application identity").toBeTruthy()
  return applicationName(identity!)
}

function applicationName(identity: string) {
  return identity.slice(identity.indexOf("/") + 1)
}

function releaseURLState(page: Page) {
  const url = new URL(page.url())
  return {
    pathname: url.pathname,
    project: url.searchParams.get("project"),
    cluster: url.searchParams.get("cluster"),
    stage: url.searchParams.get("stage"),
    namespace: url.searchParams.get("namespace"),
    q: url.searchParams.get("q"),
    hash: url.hash,
  }
}

async function expectQueryState(page: Page, expected: Record<string, string | null>) {
  await expect.poll(() => {
    const search = new URL(page.url()).searchParams
    return Object.fromEntries(Object.keys(expected).map((key) => [key, search.get(key)]))
  }).toEqual(expected)
}

function allowDashboardRedirectCancellations(runtimeAudit: RuntimeAudit) {
  // The legacy hash migrator replaces the route as soon as it mounts. Depending
  // on scheduling, that intentionally cancels some or all of the dashboard's
  // finite startup fanout before a response exists.
  runtimeAudit.allowOptionalRequestFailure(
    /^\/paprika\.v1\.PaprikaService\//u,
    "POST",
    "net::ERR_ABORTED",
    dashboardRedirectRequestFanout,
  )
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

async function expectScopeInHref(link: Locator, scope: URLSearchParams) {
  const href = await link.getAttribute("href")
  expect(href, "scope-preserving navigation needs a native href").toBeTruthy()
  const destination = new URL(href!, baseURL)
  expectScopeParameters(destination.searchParams, scope)
}

async function expectScopeInURL(page: Page, scope: URLSearchParams) {
  await expect.poll(() => {
    const actual = new URL(page.url()).searchParams
    return Object.fromEntries([...scope.keys()].map((key) => [key, actual.getAll(key)]))
  }).toEqual(Object.fromEntries([...scope.keys()].map((key) => [key, scope.getAll(key)])))
}

function expectScopeParameters(actual: URLSearchParams, expected: URLSearchParams) {
  for (const key of expected.keys()) {
    expect(actual.getAll(key), `scope field ${key}`).toEqual(expected.getAll(key))
  }
}
