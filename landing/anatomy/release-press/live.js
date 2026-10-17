const DATA = __TURN_DATA__;
const stage = document.querySelector(".rp-stage");
const buttons = [...document.querySelectorAll(".rp-controls button")];
const evidence = document.querySelector("[data-evidence]");
const readout = document.querySelector("[data-readout]");
const announcement = document.querySelector("[data-announce]");
const manual = document.querySelector("[data-manual]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const NAMES = ["Development Application", "Staging Application", "Production Application"];
const NOTES = [
  "GitOps selects a source revision for the development Application. Its own Release deploys to its configured Stage and target; health and sync are then observed.",
  "A completed development Release can qualify the staging candidate with fresh upstream Healthy/Synced evidence and configured verification. Staging deploys that exact Git SHA in its own Release.",
  "A completed staging Release can qualify the production candidate with fresh upstream Healthy/Synced evidence and configured verification. Production uses its own Stage, target, and Release.",
];
let choice = 0;
let angle = 90;
let target = 90;
let slide = 0;
let targetSlide = 0;
let frame = 0;
let last = 0;
let visible = false;
let dragging = null;
const controller = TURN.mount(stage, DATA.turn, {
  onHold: () => {},
});
const paint = () => controller.set({ carriage: slide, die: angle }, { detail: 1 });
const show = (announce = false) => {
  buttons.forEach((button, index) => button.setAttribute("aria-pressed", String(index === choice)));
  stage.querySelectorAll("[data-bay-id]").forEach((item) => {
    if (Number(item.dataset.bayId) === choice) item.setAttribute("data-selected", "");
    else item.removeAttribute("data-selected");
  });
  stage.setAttribute("aria-valuenow", String(choice));
  stage.setAttribute("aria-valuetext", NAMES[choice]);
  readout.textContent = NAMES[choice];
  manual.disabled = choice !== 2;
  manual.parentElement.toggleAttribute("data-inactive", manual.disabled);
  evidence.textContent = NOTES[choice] + (choice === 2 && manual.checked
    ? " A configured manual sync policy can hold this selected candidate for approval."
    : "");
  if (announce) announcement.textContent = `${NAMES[choice]} selected. ${evidence.textContent}`;
};
const run = () => {
  if (visible && !frame) { last = 0; frame = requestAnimationFrame(tick); }
};
const choose = (index, announce = true) => {
  choice = Math.max(0, Math.min(2, index));
  target = 90 - choice * 120;
  targetSlide = choice * 68;
  if (still.matches) { angle = target; slide = targetSlide; paint(); }
  show(announce);
  run();
};
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  angle = still.matches ? target : angle + (target - angle) * (1 - Math.exp(-dt / 0.27));
  slide = still.matches ? targetSlide : slide + (targetSlide - slide) * (1 - Math.exp(-dt / 0.34));
  if (Math.abs(target - angle) < 0.02) angle = target;
  if (Math.abs(targetSlide - slide) < 0.02) slide = targetSlide;
  paint();
  frame = visible && (angle !== target || slide !== targetSlide) ? requestAnimationFrame(tick) : 0;
}
new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (!visible) { if (frame) cancelAnimationFrame(frame); frame = 0; }
  else run();
}, { rootMargin: "120px 0px" }).observe(stage);
buttons.forEach((button, index) => button.addEventListener("click", () => choose(index)));
manual.addEventListener("change", () => show(true));
stage.addEventListener("pointerdown", (event) => {
  dragging = { id: event.pointerId, start: pointerAngle(event), base: target, captured: false };
});
// TURN.angleAt assumes a fixed turn origin. This die is nested in a travelling
// carriage, so remap the pointer by the carriage's current projected offset.
function pointerAngle(event) {
  const anchor = controller.anchor("carriage", DATA.pivot).screen;
  const svg = stage.querySelector("svg.iso-svg");
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const shiftX = ((anchor[0] - DATA.pivotScreen[0]) / vb.width) * rect.width;
  const shiftY = ((anchor[1] - DATA.pivotScreen[1]) / vb.height) * rect.height;
  return controller.angleAt(event.clientX - shiftX, event.clientY - shiftY, 20.6, "die");
}
stage.addEventListener("pointermove", (event) => {
  if (!dragging || dragging.id !== event.pointerId) return;
  const now = pointerAngle(event);
  const delta = now - dragging.start;
  if (!dragging.captured && Math.abs(delta) > 2) {
    dragging.captured = true;
    stage.setPointerCapture(event.pointerId);
    stage.setAttribute("data-drag", "");
  }
  if (!dragging.captured) return;
  target = dragging.base + delta;
  run();
});
const release = (event) => {
  if (!dragging || dragging.id !== event.pointerId) return;
  const moved = dragging.captured;
  dragging = null;
  stage.removeAttribute("data-drag");
  if (moved) {
    try { stage.releasePointerCapture(event.pointerId); } catch {}
    choice = Math.max(0, Math.min(2, Math.round((90 - target) / 120)));
    target = 90 - choice * 120;
    targetSlide = choice * 68;
    show(true);
    run();
  }
};
stage.addEventListener("pointerup", release);
stage.addEventListener("pointercancel", release);
stage.addEventListener("keydown", (event) => {
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") next = choice + 1;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = choice - 1;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = 2;
  if (next === null) return;
  event.preventDefault();
  choose(next);
});
still.addEventListener?.("change", () => {
  if (still.matches) { angle = target; slide = targetSlide; paint(); }
});
show();
paint();
