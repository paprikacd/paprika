import assert from "node:assert/strict"

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

/** Exercise the visible, app-owned confirmation; do not auto-accept browser dialogs. */
export async function respondToGammaConfirmation(page, action) {
  const dialog = page.getByRole("alertdialog")
  await dialog.waitFor()
  await dialog.getByRole("button", { name: action, exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
}
