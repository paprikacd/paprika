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

/**
 * The application detail's split: the divider states the split, the keyboard
 * and the pointer can both move it, and the operator's width survives a
 * reload.
 */
test("the detail rail divider states and changes the split", async ({ page }) => {
  await page.goto("/dashboard/")
  const attention = page.getByRole("region", { name: "03 Needs attention" })
  const href = await attention
    .getByRole("listitem")
    .first()
    .getByRole("link")
    .first()
    .getAttribute("href")
  await page.goto(href!)

  const separator = page.getByRole("separator", {
    name: "Resize the application detail rail",
  })
  await expect(separator).toBeVisible()
  await expect(separator).toHaveAttribute("aria-orientation", "vertical")

  const before = Number(await separator.getAttribute("aria-valuenow"))
  await separator.focus()
  await page.keyboard.press("ArrowRight")
  const after = Number(await separator.getAttribute("aria-valuenow"))
  expect(after).toBeGreaterThan(before)

  // The rail really is wider afterwards.
  const rail = page.locator('[data-slot="resizable-panes"] > div').last()
  const railBox = (await rail.boundingBox())!
  expect(railBox.width).toBeGreaterThan(240)

  // A pointer drag moves it as well.
  const separatorBox = (await separator.boundingBox())!
  const group = page.locator('[data-slot="resizable-panes"]')
  const groupBox = (await group.boundingBox())!
  await page.mouse.move(
    separatorBox.x + separatorBox.width / 2,
    separatorBox.y + separatorBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(groupBox.x + groupBox.width * 0.55, separatorBox.y + 40)
  await page.mouse.up()
  const dragged = Number(await separator.getAttribute("aria-valuenow"))
  expect(dragged).toBeLessThan(after)
  expect(dragged).toBeGreaterThanOrEqual(55)

  // And the split survives a reload.
  await page.reload()
  await expect(
    page.getByRole("separator", { name: "Resize the application detail rail" }),
  ).toHaveAttribute("aria-valuenow", String(dragged))
})
