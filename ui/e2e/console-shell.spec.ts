import { expect, test } from "@playwright/test"

/**
 * The console shell's own surfaces: the command palette and the tooltips that
 * explain what a truncated value really says. Both are checked in a real
 * browser because focus, viewport containment and navigation are the whole
 * contract — a unit test cannot see them.
 */

test("the command palette opens, filters and navigates", async ({ page }) => {
  await page.goto("/dashboard/")
  const trigger = page.getByRole("button", { name: /Search commands/ })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole("combobox")
  await expect(input).toBeFocused()

  // The console's own destinations are always offered.
  await expect(dialog.getByRole("option", { name: /Overview/ })).toBeVisible()
  await expect(dialog.getByRole("option", { name: /Fleet map/ })).toBeVisible()

  // Typing narrows the list.
  await input.fill("roll")
  await expect(dialog.getByRole("option", { name: /Rollouts/ })).toBeVisible()
  await expect(dialog.getByRole("option", { name: /Fleet map/ })).toHaveCount(0)

  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/dashboard\/rollouts\//)
})

test("the palette opens on the keyboard shortcut and closes on Escape", async ({
  page,
}) => {
  await page.goto("/dashboard/")
  await page.keyboard.press("Meta+k")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("the freshness tooltip explains the polling cadence", async ({ page }) => {
  await page.goto("/dashboard/")
  const chip = page.getByText(/polled|polling|refreshing/).first()
  await expect(chip).toBeVisible()
  await chip.hover()

  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(/polls/i)

  const box = (await tooltip.boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y).toBeGreaterThanOrEqual(0)
})
