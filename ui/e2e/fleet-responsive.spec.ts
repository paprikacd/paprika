import {
  expect,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test"

import {
  expectCompleteHeatmap,
  observeFleetMapResponses,
  type FleetMapOracle,
} from "./helpers/fleet-map-oracle"
import { installRuntimeAudit, type RuntimeAudit } from "./helpers/runtime-audit"

const responsiveViewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
] as const

type RuntimeAuditFixtures = {
  runtimeAudit: RuntimeAudit
  fleetMapOracle: FleetMapOracle
}
const test = base.extend<RuntimeAuditFixtures>({
  runtimeAudit: [
    async ({ page }, use) => {
      const audit = installRuntimeAudit(page)
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

test.setTimeout(120_000)

test.beforeEach(async ({ request }) => {
  await expectFixtureReady(request)
})

for (const viewport of responsiveViewports) {
  test(`${viewport.name} renders every fleet route and presentation without page overflow`, async ({
    page,
    fleetMapOracle: oracle,
  }) => {
    await page.setViewportSize(viewport)

    await page.goto("/dashboard/")
    await expectCompleteHeatmap(page, oracle, 250)
    await assertResponsiveRoute(page, `${viewport.name} Overview`)

    const presentations = ["heatmap", "treemap", "matrix", "table", "queue"] as const
    for (const presentation of presentations) {
      await page.goto(`/dashboard/applications?view=${presentation}`)
      await expect(page.locator('[data-fleet-ready="250"]')).toBeVisible()
      if (presentation === "heatmap") {
        await expectCompleteHeatmap(page, oracle, 250)
      } else if (presentation === "treemap") {
        await expect(page.getByRole("application", { name: "Fleet treemap" })).toBeVisible()
      } else if (presentation === "matrix") {
        await expect(page.getByRole("table", { name: "Fleet matrix" })).toBeVisible()
      } else if (presentation === "table") {
        await expect(page.getByRole("table", { name: "Applications" })).toBeVisible()
      } else {
        await expect(page.getByRole("region", { name: "Attention queue" })).toBeVisible()
      }
      await assertResponsiveRoute(page, `${viewport.name} Applications ${presentation}`)
    }

    await page.goto("/dashboard/releases/")
    await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible()
    await assertResponsiveRoute(page, `${viewport.name} Releases`)

    await page.goto("/dashboard/rollouts/")
    await expect(page.getByRole("heading", { level: 1, name: "Rollouts" })).toBeVisible()
    await assertResponsiveRoute(page, `${viewport.name} Rollouts`)

    await page.goto("/dashboard/#pipelines")
    await expect(page.locator("#pipelines")).toBeVisible()
    await expect(page.locator("#pipelines").getByRole("heading", { name: "Pipelines" })).toBeVisible()
    await assertResponsiveRoute(page, `${viewport.name} Pipelines`)

    await page.goto(
      "/dashboard/application?application_namespace=team-00&application_name=checkout-service",
    )
    await expect(page.getByRole("heading", { level: 1, name: "checkout-service" })).toBeVisible()
    await assertResponsiveRoute(page, `${viewport.name} Application detail`)
  })
}

async function expectFixtureReady(request: APIRequestContext) {
  const response = await request.get("/readyz")
  expect(response.ok(), `/readyz returned ${response.status()}`).toBe(true)
  expect(await response.text()).toBe("ready\n")
}

async function assertResponsiveRoute(page: Page, description: string) {
  await page.waitForLoadState("networkidle")
  const dimensions = await page.locator("html").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(
    dimensions.scrollWidth - dimensions.clientWidth,
    `${description} must not introduce document-level horizontal overflow`,
  ).toBeLessThanOrEqual(1)

  const control = page.locator(
    'main a:visible, main button:not(:disabled):visible, main input:visible, main select:visible, main [role="application"]:visible',
  ).first()
  await expect(control, `${description} needs a focusable critical control`).toBeVisible()
  await control.scrollIntoViewIfNeeded()
  await control.focus()
  await expect(control, `${description} critical control must accept focus`).toBeFocused()
  await expectFocusedControlInViewport(page, control, description)
}

async function expectFocusedControlInViewport(page: Page, control: Locator, description: string) {
  const box = await control.boundingBox()
  expect(box, `${description} focused control must expose geometry`).not.toBeNull()
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  expect(box!.x, `${description} focused control left edge`).toBeGreaterThanOrEqual(0)
  expect(box!.y, `${description} focused control top edge`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${description} focused control right edge`)
    .toBeLessThanOrEqual(viewport!.width + 1)
  expect(box!.y + box!.height, `${description} focused control bottom edge`)
    .toBeLessThanOrEqual(viewport!.height + 1)
}
