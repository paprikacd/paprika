import "@testing-library/jest-dom/vitest"

// jsdom has no top layer. Model only native open/close state here; actual modal
// focus trapping, inertness and Escape are verified in the browser E2E suites.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
}
