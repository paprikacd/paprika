import assert from "node:assert/strict"

/** Commit a focused chart draft before operating on dashboard-level controls. */
export async function applyWidgetChanges(page) {
  const editor = page.getByRole("region", { name: "Widget editor", exact: true })
  if (await editor.isVisible()) {
    await editor.getByRole("button", { name: "Apply changes", exact: true }).click()
    await editor.waitFor({ state: "hidden" })
  }
}

/** Menu names for dashboard actions that the phone shell moves into the Dashboard actions menu. */
const phoneMenuNames = { Code: "Dashboard as code", Queries: "Query inspector" }

/** Open a dashboard action through its visible desktop button or the Dashboard actions menu (phone shell and compact). */
export async function activateDashboardAction(page, name) {
  if (name === "Save dashboard") await applyWidgetChanges(page)
  const button = page.getByRole("button", { name, exact: true })
  if (await button.isVisible()) {
    await button.click()
    return
  }
  await page.getByRole("button", { name: "Dashboard actions", exact: true }).click()
  await page.getByRole("menuitem", { name: phoneMenuNames[name] ?? name, exact: true }).click()
}

/** Start editing through whichever control this viewport shows: the Edit button, or the Dashboard actions menu on phones. Already editing is a no-op. */
export async function openDashboardEditor(page) {
  const title = page.getByRole("textbox", { name: "Dashboard title", exact: true })
  if (await title.isVisible()) return
  await activateDashboardAction(page, "Edit dashboard")
  await title.waitFor()
}

/** Choose through Gamma's visible button/listbox, including its body portal. */
export async function selectGammaOption(page, trigger, optionName) {
  assert.equal(await trigger.evaluate((element) => element.tagName), "BUTTON", "Gamma select must expose its real trigger")
  assert.equal(await trigger.getAttribute("role"), "combobox")
  await trigger.click()
  assert.equal(await trigger.getAttribute("aria-expanded"), "true")
  const listId = await trigger.getAttribute("aria-controls")
  assert.ok(listId, "Open Gamma select must reference its option list")
  const list = page.locator(`[id=${JSON.stringify(listId)}]`)
  await list.getByRole("option", { name: optionName, exact: typeof optionName === "string" }).click()
  await list.waitFor({ state: "hidden" })
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true, "Selection should return focus to the trigger")
}

/**
 * Toggle options of a several-value Gamma select. The panel stays open after each toggle and commits once when it
 * closes, so this clicks each named row and then closes the panel with Escape. Use it for GammaMultiSelect triggers.
 */
export async function toggleGammaOptions(page, trigger, optionNames) {
  assert.equal(await trigger.getAttribute("role"), "combobox")
  await trigger.click()
  assert.equal(await trigger.getAttribute("aria-expanded"), "true")
  const listId = await trigger.getAttribute("aria-controls")
  assert.ok(listId, "Open Gamma select must reference its option list")
  assert.equal(await page.locator(`[id=${JSON.stringify(listId)}]`).getAttribute("aria-multiselectable"), "true")
  const list = page.locator(`[id=${JSON.stringify(listId)}]`)
  for (const optionName of optionNames)
    await list.getByRole("option", { name: optionName, exact: true }).click()
  await trigger.press("Escape")
  await list.waitFor({ state: "hidden" })
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
}

/** Exercise the visible, app-owned confirmation; do not auto-accept browser dialogs. */
export async function respondToGammaConfirmation(page, action) {
  const dialog = page.getByRole("alertdialog")
  await dialog.waitFor()
  await dialog.getByRole("button", { name: action, exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
}

/** Wait until a save or cancel has left edit mode: the title field is gone and the view's Edit control, or the phone menu, is present. */
export async function waitForDashboardView(page) {
  await page.getByRole("textbox", { name: "Dashboard title", exact: true }).waitFor({ state: "hidden" })
  await page.getByRole("button", { name: /^(Edit dashboard|Dashboard actions)$/ }).first().waitFor()
}

/** Variables sit in the toolbar, or in the native bottom sheet behind the phone chip. Opens the sheet when the chip is shown and returns the variables form. */
export async function openDashboardVariables(page) {
  const chip = page.getByRole("button", { name: /^Dashboard variables:/ })
  if (await chip.count() === 0) return page.getByRole("form", { name: "Dashboard variables", exact: true })
  if (await page.locator("dialog[open]").count() === 0) {
    await chip.click()
    await page.locator("dialog[open]").waitFor()
  }
  return page.locator("dialog[open]").locator("form")
}

/** Closes the phone variables sheet when it is open, because it is modal and makes the rest of the page inert. */
export async function closeDashboardVariables(page) {
  const sheet = page.locator("dialog[open]")
  if (await sheet.count() === 0) return
  await sheet.getByRole("button", { name: "Done", exact: true }).click()
  await sheet.waitFor({ state: "detached" })
}

/** Choose one option of a dashboard variable through the variables form: opens the phone sheet when shown, selects, and closes the sheet again so the page is not left inert. */
export async function selectDashboardVariable(page, name, optionName) {
  const form = await openDashboardVariables(page)
  await selectGammaOption(page, form.getByRole("combobox", { name, exact: true }), optionName)
  await closeDashboardVariables(page)
}
