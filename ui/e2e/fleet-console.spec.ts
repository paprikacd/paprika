import {
  expect,
  test as base,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test"

const baseURL = "http://127.0.0.1:3100"
const keyboardProject = "chromium-keyboard-only"
const projectKey = "team-00/payments"
const fuzzyApplication = "team-00/checkout-service"

type EventAuditFixtures = {
  eventAudit: void
}

const test = base.extend<EventAuditFixtures>({
  eventAudit: [
    async ({ page }, use) => {
      const eventRequests: string[] = []
      const recordRequest = (request: Request) => {
        if (new URL(request.url()).pathname === "/events") {
          eventRequests.push(request.url())
        }
      }

      page.on("request", recordRequest)
      await use(undefined)
      page.off("request", recordRequest)

      expect(
        eventRequests,
        "the compiled console must never request the unauthorised legacy event stream",
      ).toEqual([])
    },
    { auto: true },
  ],
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

  const filterDisclosure = page.locator("summary").filter({ hasText: "Filter dimensions" })
  await activate(page, filterDisclosure, testInfo)

  const projectFilter = page.getByRole("checkbox", { name: `Project ${projectKey}` })
  await activate(page, projectFilter, testInfo, "Space")
  await expect.poll(() => queryValues(page, "project")).toEqual([projectKey])

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
  const applicationName = destination.searchParams.get("name")
  const namespace = destination.searchParams.get("namespace")
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
}, testInfo) => {
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
  await activate(page, investigateButton, testInfo, "Enter")

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

test("redirects the legacy applications hash to the dedicated inventory", async ({ page }) => {
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
