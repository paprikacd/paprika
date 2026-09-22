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

test("serves the compiled shell with exact links that all resolve", async ({ page }) => {
  await page.goto("/dashboard/applications")

  await expect(page.getByRole("heading", { level: 1, name: "Applications" })).toBeVisible()
  const navigation = page.getByRole("navigation", { name: "Fleet sections" })
  const expectedLinks = [
    ["Overview", "/dashboard/"],
    ["Applications", "/dashboard/applications/"],
    ["Fleet map", "/dashboard/map/"],
    ["Pipelines", "/dashboard/pipelines/"],
    ["Rollouts", "/dashboard/rollouts/"],
    ["Sync & diff", "/dashboard/diff/"],
    ["Repositories", "/dashboard/repositories/"],
    ["Templates", "/dashboard/templates/"],
    ["Clusters", "/dashboard/clusters/"],
  ] as const

  // The rail carries these nine destinations, in this order, and nothing else:
  // an extra, missing or reordered entry fails here.
  await expect
    .poll(() =>
      navigation
        .getByRole("link")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    )
    .toEqual(expectedLinks.map(([, href]) => href))
  for (const [name, href] of expectedLinks) {
    await expect(navigation.getByRole("link", { name, exact: true })).toHaveAttribute("href", href)
  }

  // The nav no longer carries disabled placeholders, so the guarantee that
  // clause bought — no dead entries in the rail — is asserted directly: every
  // href must be served by a compiled route of its own. The export routes any
  // unknown extensionless path to the application shell with a 200, so the
  // shell is fetched first and used as the negative control.
  const notFound = await page.request.get("/dashboard/not-a-compiled-route/")
  expect(notFound.status()).toBe(200)
  const shell = await notFound.text()

  for (const [name, href] of expectedLinks) {
    const response = await page.request.get(href)
    expect(response.status(), `${name} → ${href} must be served`).toBe(200)
    expect(
      await response.text(),
      `${name} → ${href} must be a compiled route, not the not-found shell`,
    ).not.toBe(shell)
  }
})

test("applies a namespaced project facet and typo-tolerant application search", async ({
  page,
}, testInfo) => {
  // Project is scoped from the console header, and its options are the server's
  // project facet buckets. They are labelled by name alone, so the run is
  // namespaced to team-00 first: exactly one `payments` bucket is then on
  // offer, and choosing it must still write the namespaced key.
  await page.goto("/dashboard/applications?view=table&namespace=team-00")
  await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
  const sentinel = page.getByTestId("fleet-load-more-sentinel")
  await expect(sentinel).toContainText("21 loaded / 21 indexed")

  const projectScope = page.getByRole("combobox").filter({ hasText: "Project" })
  await expect(projectScope).toHaveCount(1)
  await activate(page, projectScope, testInfo)
  const projectOption = page.getByRole("option").filter({ hasText: /^payments/ })
  await expect(projectOption).toHaveCount(1)
  await chooseOption(page, projectOption, testInfo)

  await expect.poll(() => queryValues(page, "project")).toEqual([projectKey])
  await expect(sentinel).toContainText("9 loaded / 9 indexed")

  // The chip toolbar replaced the checkbox fieldsets. A chip's count is what
  // selecting it yields — facets are self-excluding — so the count printed on
  // the chip is asserted against the scope the chip produces, and toggling it
  // off must give the project scope back.
  const rolloutChip = page
    .getByRole("group", { name: "Facet filters" })
    .getByRole("button", { name: /^paused, \d+ applications$/ })
  await expect(rolloutChip).toHaveCount(1)
  const chipLabel = await rolloutChip.getAttribute("aria-label")
  const chipCount = Number(/^paused, (\d+) applications$/.exec(chipLabel ?? "")?.[1])
  expect(chipCount).toBeGreaterThan(0)
  expect(chipCount).toBeLessThan(9)

  await activate(page, rolloutChip, testInfo)
  await expect.poll(() => queryValues(page, "rollout")).toEqual(["paused"])
  await expect(rolloutChip).toHaveAttribute("aria-pressed", "true")
  await expect(sentinel).toContainText(`${chipCount} loaded / ${chipCount} indexed`)

  await activate(page, rolloutChip, testInfo)
  await expect.poll(() => queryValues(page, "rollout")).toEqual([])
  await expect(sentinel).toContainText("9 loaded / 9 indexed")

  const search = page.getByRole("searchbox", {
    name: "Filter applications by name, project, cluster or revision",
  })
  await enterText(page, search, "checkout servce", testInfo)
  await expect.poll(() => queryValue(page, "q")).toBe("checkout servce")

  await expect(page.getByRole("row", { name: fuzzyApplication })).toBeVisible()
  await expect(sentinel).toContainText("1 loaded / 1 indexed")
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

  // "Highest impact attention" is now board 03, "Needs attention": the same
  // server-ranked (`sort=impact`) window, worst first.
  const attention = page.getByRole("region", { name: "03 Needs attention" })
  const applicationLink = attention.getByRole("listitem").first().getByRole("link").first()
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
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
    applicationName!,
  )
  // The "Current Phase" card became the delivery timeline: the same lifecycle
  // phase read, so the deep link still has to land on a rendered detail rather
  // than an empty shell.
  await expect(page.getByRole("heading", { name: /^Delivery timeline/ })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Application not found", exact: true }),
  ).toHaveCount(0)
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

/**
 * Commits one option of an open listbox. A listbox is arrow-driven rather than
 * tab-driven, so the keyboard-only project cannot reach it through `activate`.
 */
async function chooseOption(page: Page, option: Locator, testInfo: TestInfo) {
  const locator = option.first()
  await expect(locator).toBeVisible()
  if (testInfo.project.name !== keyboardProject) {
    await locator.click()
    return
  }

  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await locator.evaluate((element) => element.hasAttribute("data-highlighted"))) {
      await page.keyboard.press("Enter")
      return
    }
    await page.keyboard.press("ArrowDown")
  }
  throw new Error("keyboard navigation did not reach the requested option")
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

async function expectQueryState(page: Page, expected: Record<string, string | null>) {
  await expect.poll(() => {
    const search = new URL(page.url()).searchParams
    return Object.fromEntries(Object.keys(expected).map((key) => [key, search.get(key)]))
  }).toEqual(expected)
}
