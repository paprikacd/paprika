import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { ConsoleController, errorText, parseDeepLink, resourceRows, type Tab } from "./model.ts";
import { render } from "./view.ts";

const app = new App({ name: "Paprika fleet", version: "0.2.0" }, { availableDisplayModes: ["fullscreen"] }, { autoResize: true });
const extensions = new OpenAIExtensions(app);
const root = document.getElementById("console")!;
const bridge = { call: (name: string, args: Record<string, unknown>) => app.callServerTool({ name, arguments: args }) };
const storage = (() => { try { return window.localStorage; } catch { return undefined; } })();
const controller = new ConsoleController(bridge, storage);
let requestedFullscreen = false;
let currentDeepLink = "";
let buttonFocus: { key: string; value: string; namespace?: string } | undefined;
let dialogWasOpen = false;

root.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) { buttonFocus = undefined; return; }
  const key = ["action", "tab", "app", "log", "instance", "setup", "removeInstance"].find((item) => target.dataset[item] !== undefined);
  buttonFocus = key ? { key, value: target.dataset[key]!, namespace: target.dataset.namespace } : undefined;
});
window.addEventListener("blur", () => { buttonFocus = undefined; });

function update() {
  const active = document.activeElement as HTMLElement | null;
  const focusedId = active?.id;
  const focusedButton = buttonFocus;
  const drafts = new Map([...root.querySelectorAll<HTMLInputElement>("input")].map((input) => [input.id, input.value]));
  const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : undefined;
  const previousList = root.querySelector(".app-list");
  const scroll = { left: previousList?.scrollLeft ?? 0, top: previousList?.scrollTop ?? 0 };
  const dialogScroll = root.querySelector(".instance-dialog-body")?.scrollTop ?? 0;
  const disclosures = new Map([...root.querySelectorAll<HTMLDetailsElement>("details[id]")].map((details) => [`${details.id}:${details.dataset.disclosureKey ?? ""}`, details.open]));
  root.innerHTML = render(controller.state, controller.supportsContext, controller.supportsMessage);
  for (const details of root.querySelectorAll<HTMLDetailsElement>("details[id]")) {
    const key = `${details.id}:${details.dataset.disclosureKey ?? ""}`;
    if (details.dataset.forceOpen) details.open = true;
    else if (disclosures.has(key)) details.open = disclosures.get(key)!;
  }
  if (controller.state.instanceDialog) {
    for (const input of root.querySelectorAll<HTMLInputElement>("#instance-form input")) if (drafts.has(input.id)) input.value = drafts.get(input.id)!;
  }
  // Loading updates do not erase a filter draft while the user is typing.
  if (focusedId) {
    const input = root.querySelector<HTMLInputElement>(`#${CSS.escape(focusedId)}`);
    if (input && input.tagName === "INPUT") {
      input.value = drafts.get(focusedId) ?? input.value;
      input.focus();
      if (selection && selection[0] !== null && selection[1] !== null) input.setSelectionRange(selection[0], selection[1]);
    }
    else if (input && !input.closest("[inert]")) input.focus({ preventScroll: true });
  }
  if (focusedButton && document.hasFocus()) {
    const key = focusedButton.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const selector = `button[data-${key}="${CSS.escape(focusedButton.value)}"]${focusedButton.namespace ? `[data-namespace="${CSS.escape(focusedButton.namespace)}"]` : ""}`;
    const matching = root.querySelector<HTMLButtonElement>(selector);
    if (matching && !matching.disabled && !matching.closest("[inert]")) matching.focus({ preventScroll: true });
    // If navigation replaced the invoking control (View logs), put focus on
    // the selected view. A temporarily disabled control retains its intent
    // until the request finishes so keyboard focus does not disappear.
    else if (!matching) root.querySelector<HTMLButtonElement>(`button[data-tab="${controller.state.tab}"]`)?.focus({ preventScroll: true });
  }
  const list = root.querySelector(".app-list");
  if (list) { list.scrollLeft = scroll.left; list.scrollTop = scroll.top; }
  const dialogBody = root.querySelector(".instance-dialog-body");
  if (dialogBody) dialogBody.scrollTop = dialogScroll;
  if (controller.state.instanceDialog && !dialogWasOpen) root.querySelector<HTMLButtonElement>('[data-action="close-instances"]')?.focus();
  if (!controller.state.instanceDialog && dialogWasOpen) root.querySelector<HTMLButtonElement>("#instance-picker")?.focus();
  dialogWasOpen = controller.state.instanceDialog;
}
controller.subscribe(update);
update();

root.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement)) return;
  if (event.target.id === "instance-form") {
    event.preventDefault();
    const form = new FormData(event.target);
    if (controller.saveInstance(Object.fromEntries(form.entries()))) root.querySelector<HTMLFormElement>("#instance-form")?.reset();
    return;
  }
  if (event.target.id !== "fleet-search") return;
  event.preventDefault();
  const form = new FormData(event.target);
  void controller.search(String(form.get("namespace") ?? "").trim(), String(form.get("search") ?? "").trim());
});

root.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).dataset.dismissInstances) { controller.manageInstances(false); return; }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  if (button.dataset.instance) {
    if (controller.supportsMessage) void controller.switchInstance(button.dataset.instance);
    else controller.showSetup(button.dataset.instance);
    return;
  }
  if (button.dataset.setup) { controller.showSetup(button.dataset.setup); return; }
  if (button.dataset.removeInstance) { controller.removeInstance(button.dataset.removeInstance); return; }
  if (button.dataset.app) { void controller.select({ name: button.dataset.app, namespace: button.dataset.namespace! }); return; }
  if (button.dataset.tab) { void controller.tab(button.dataset.tab as Tab); return; }
  if (button.dataset.log) {
    const rows = resourceRows(controller.state.health ?? {}, controller.state.tree);
    const row = rows[Number(button.dataset.log)];
    if (row) void controller.logs(row);
    return;
  }
  switch (button.dataset.action) {
    case "overview": controller.overview(); break;
    case "instances": controller.manageInstances(); break;
    case "close-instances": controller.manageInstances(false); break;
    case "stay-instance": controller.stayOnInstance(); break;
    case "verify-instance": void controller.verifyConnection(); break;
    case "refresh-fleet": void controller.refreshFleet(); break;
    case "refresh-health": void controller.refreshHealth(); break;
    case "more": void controller.search(controller.state.namespace, controller.state.search, true); break;
    case "resources": void controller.resources(); break;
    case "investigate": void controller.investigate(); break;
    case "attach": void controller.attach(); break;
    case "debug": void controller.ask("debug"); break;
    case "sync": void controller.ask("sync"); break;
  }
});

root.addEventListener("keydown", (event) => {
  if (!controller.state.instanceDialog) return;
  if (event.key === "Escape") { event.preventDefault(); controller.manageInstances(false); return; }
  if (event.key !== "Tab") return;
  const controls = [...root.querySelectorAll<HTMLElement>('#instance-dialog button:not([disabled]), #instance-dialog input:not([disabled]), #instance-dialog summary, #instance-dialog pre[tabindex="0"]')]
    .filter((control) => control.getClientRects().length > 0);
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement?.id === "instance-dialog")) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function hostContext() {
  const context = app.getHostContext();
  if (context?.theme) {
    applyDocumentTheme(context.theme);
    document.documentElement.dataset.theme = context.theme;
  }
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  Object.assign(bridge, {
    context: extensions.modelContext ? (data: Parameters<typeof app.updateModelContext>[0]) => extensions.modelContext!.update(data) : undefined,
    message: extensions.message ? (text: string) => extensions.message!.send({ role: "user", content: [{ type: "text", text }] }) : undefined,
  });
  // Resource metadata also requests fullscreen. If a host starts inline,
  // request the advertised side-panel mode once and accept its response.
  if (!requestedFullscreen && context?.displayMode === "inline" && context.availableDisplayModes?.includes("fullscreen")) {
    requestedFullscreen = true;
    void app.requestDisplayMode({ mode: "fullscreen" }).catch((err) => controller.connectionError(`Unable to expand the fleet view: ${errorText(err)}`));
  }
  const deepLink = extensions.deepLink.getCurrent()?.url;
  if (deepLink && deepLink !== currentDeepLink) {
    currentDeepLink = deepLink;
    const selected = parseDeepLink(deepLink);
    if (selected) void controller.select(selected);
  }
  update();
}

// Register notifications before connecting so the host's launch data cannot
// race initialization. Rendering does not invoke the opener again.
app.ontoolresult = (result) => { void controller.launch(result).catch((err) => controller.connectionError(errorText(err))); };
app.ontoolcancelled = () => controller.connectionError("The fleet request was cancelled. Ask the conversation to open the fleet again.");
app.onerror = (err) => controller.connectionError(errorText(err));
app.onhostcontextchanged = hostContext;
window.addEventListener("error", (event) => controller.connectionError(event.message || "The console encountered an error."));
window.addEventListener("unhandledrejection", (event) => controller.connectionError(errorText(event.reason)));

void app.connect().then(() => { controller.connected(); hostContext(); }).catch((err) => controller.connectionError(`Unable to connect to the host: ${errorText(err)}`));
