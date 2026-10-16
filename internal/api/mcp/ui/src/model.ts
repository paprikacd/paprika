// Tool data is untrusted. Keep parsing tolerant of absent proto fields and
// collection wrappers, and never interpret tool text as HTML or instructions.
import { parseConnection, parseInstance, readInstances, switchPrompt, writeInstances, type ConnectionIdentity, type Instance, type PreferenceStorage } from "./connections.ts";
export type Json = Record<string, unknown>;
export const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
export const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
export const number = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
export const field = (value: Json, camel: string): unknown => value[camel] ?? value[camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
export const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

export function label(value: unknown, fallback = "Unknown"): string {
  const text = string(value);
  if (!text) return fallback;
  return text.replace(/^(?:FLEET_HEALTH_|FLEET_SYNC_STATE_|FLEET_RELEASE_STATE_|FLEET_ROLLOUT_STATE_|DATA_STATE_|DRIFT_REASON_|DRIFT_CATEGORY_|SEVERITY_)/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase().split(/[_ ]/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export function tone(value: unknown): string {
  const text = string(value).toLowerCase();
  if (/(unknown|unspecified|unavailable|not.available|not.configured|stale)/.test(text) || !text) return "neutral";
  if (/(unhealthy|degraded|failed|error|critical|missing|rolled.?back|exhausted)/.test(text)) return "danger";
  if (/(healthy|synced|complete|passed|success|ready|approved)/.test(text) && !/(out.of.sync|not.synced)/.test(text)) return "success";
  return "warning";
}

export function identity(value: Json): { name: string; namespace: string } {
  const key = object(value.identity);
  return { name: string(key.name || value.name), namespace: string(key.namespace || value.namespace) };
}

export function parseDeepLink(value: string): { name: string; namespace: string } | undefined {
  // Host deep links are app-relative routes, not MCP resource URIs. Match
  // before URL normalization so traversal, query and fragments cannot alias
  // a valid application route.
  const match = /^\/applications\/([^/?#]+)\/([^/?#]+)$/.exec(value);
  if (!match) return;
  try {
    const namespace = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
    if (namespace.length > 63 || !label.test(namespace)) return;
    if (name.length > 253 || !name.split(".").every((part) => part.length <= 63 && label.test(part))) return;
    return { namespace, name };
  } catch { return; }
}

export function payload(result: unknown): Json {
  const response = object(result);
  if (response.isError) {
    const text = array(response.content).filter((item) => item.type === "text").map((item) => string(item.text)).join("\n");
    throw new Error(text || "Paprika could not complete this request.");
  }
  if (response.structuredContent) return object(response.structuredContent);
  for (const item of array(response.content)) {
    if (item.type !== "text") continue;
    try { return object(JSON.parse(string(item.text))); } catch { /* Try the next text block. */ }
  }
  throw new Error("Paprika returned no structured data.");
}

export function collection(value: unknown): Json[] {
  return array(object(value).data ?? value);
}

export function resourceRows(health: Json, tree?: Json): Json[] {
  if (tree) return array(tree.nodes);
  const resources = object(health.resources);
  // These reports lack API groups. Keep their records independent rather
  // than joining same-named kinds from potentially different API groups.
  return [
    ...collection(resources.health).map((item) => ({ ...item, evidence: "Health report" })),
    ...collection(resources.sync).map((item) => ({ ...item, syncStatus: item.status, evidence: "Sync report" })),
  ];
}

export type Tab = "health" | "resources" | "releases" | "debug";
export interface ToolBridge {
  call(name: string, args: Json): Promise<unknown>;
  context?: (args: Json) => Promise<unknown>;
  message?: (text: string) => Promise<unknown>;
}
export interface State {
  connected: boolean;
  connection?: ConnectionIdentity;
  instances: Instance[];
  instanceDialog: boolean;
  setupInstance?: Instance;
  switchTarget?: Instance;
  storageUnavailable: boolean;
  fleet: Json;
  applications: Json[];
  total: number;
  cursor: string;
  namespace: string;
  search: string;
  observedAt: string;
  selected?: { name: string; namespace: string };
  health?: Json;
  tree?: Json;
  investigation?: Json;
  logs?: Json;
  logResource?: Json;
  tab: Tab;
  busy: Set<string>;
  errors: Record<string, string>;
  notice: string;
}

export class ConsoleController {
  state: State = { connected: false, instances: [], instanceDialog: false, storageUnavailable: false, fleet: {}, applications: [], total: 0, cursor: "", namespace: "", search: "", observedAt: "", tab: "health", busy: new Set(), errors: {}, notice: "" };
  private listeners = new Set<() => void>();
  private selection = 0;
  private fleetRequest = 0;
  private requests = new Map<string, number>();
  private bridge: ToolBridge;
  private storage?: PreferenceStorage;
  private identityRequest = 0;
  constructor(bridge: ToolBridge, storage?: PreferenceStorage) {
    this.bridge = bridge;
    this.storage = storage;
    const saved = readInstances(storage);
    this.state.instances = saved.instances;
    this.state.storageUnavailable = saved.unavailable;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) listener(); }
  connected() { this.state.connected = true; this.emit(); }
  connectionError(message: string) { this.state.errors.connection = message; this.emit(); }
  private busy(key: string, value: boolean) { if (value) { this.state.busy.add(key); delete this.state.errors[key]; } else this.state.busy.delete(key); this.emit(); }

  async launch(result: unknown) {
    const initial = payload(result);
    if (!initial.fleet || !initial.applications) return;
    if (!this.acceptConnection(initial.connection)) return;
    this.state.fleet = object(initial.fleet);
    this.applyApplications(object(initial.applications), false);
    this.state.observedAt = string(initial.observedAt, new Date().toISOString());
    this.state.namespace = string(initial.namespace);
    this.state.search = string(initial.search);
    this.emit();
    if (!this.state.connection) await this.verifyConnection();
    // The opener already delivered the fleet. Only fetch the selected app's
    // richer evidence, never repeat open_fleet during initialization.
    const attention = array(this.state.fleet.attention)[0];
    const first = attention ?? this.state.applications[0];
    if (first && !this.state.selected) await this.select(identity(first));
  }

  private acceptConnection(value: unknown): boolean {
    const connection = parseConnection(value);
    if (!connection) {
      if (value === undefined) return true;
      this.state.errors.identity = "This response declared an invalid instance identity. Its evidence was not loaded; verify the originating connection before continuing.";
      this.emit();
      return false;
    }
    if (this.state.connection && connection.endpoint !== this.state.connection.endpoint) {
      this.state.errors.identity = "A different instance reported into this console. Open a new console from that connection; this view remains bound to its original instance.";
      this.emit();
      return false;
    }
    this.state.connection = connection;
    delete this.state.errors.identity;
    return true;
  }

  async verifyConnection() {
    const request = ++this.identityRequest;
    this.busy("identity", true);
    try {
      const data = payload(await this.bridge.call("get_connection", {}));
      if (request !== this.identityRequest) return;
      const connection = parseConnection(data.connection ?? data);
      if (!connection) throw new Error("This server did not provide a valid instance identity.");
      this.acceptConnection(connection);
    } catch (error) {
      if (request === this.identityRequest) this.state.errors.identity = `Instance identity could not be verified. ${errorText(error)} Read tools stay on the originating connection; sync requests are disabled until verification succeeds.`;
    } finally { if (request === this.identityRequest) this.busy("identity", false); }
  }

  manageInstances(open = true) {
    this.state.instanceDialog = open;
    if (!open) this.state.setupInstance = undefined;
    this.emit();
  }

  showSetup(connection: string) {
    this.state.setupInstance = this.state.instances.find((item) => item.connection === connection);
    this.emit();
  }

  saveInstance(input: unknown): boolean {
    const instance = parseInstance(input);
    if (!instance) {
      this.state.errors.instance = "Enter a name, a connection name starting with a letter (letters, numbers, underscores or hyphens), and an HTTPS endpoint ending in /mcp. Credentials, query strings and fragments are not supported.";
      this.emit();
      return false;
    }
    if (!this.state.instances.some((item) => item.connection === instance.connection) && this.state.instances.filter((item) => !item.example).length >= 20) {
      this.state.errors.instance = "You can save up to 20 instances. Forget a saved preference before adding another.";
      this.emit();
      return false;
    }
    this.state.instances = [...this.state.instances.filter((item) => item.connection !== instance.connection), instance];
    this.state.storageUnavailable = !writeInstances(this.storage, this.state.instances);
    this.state.setupInstance = instance;
    delete this.state.errors.instance;
    this.emit();
    return true;
  }

  removeInstance(connection: string) {
    this.state.instances = this.state.instances.filter((item) => item.connection !== connection || item.example);
    this.state.storageUnavailable = !writeInstances(this.storage, this.state.instances);
    if (this.state.setupInstance?.connection === connection) this.state.setupInstance = undefined;
    this.emit();
  }

  async switchInstance(connection: string) {
    const target = this.state.instances.find((item) => item.connection === connection);
    if (!target || this.state.busy.has("switch") || target.endpoint === this.state.connection?.endpoint) return;
    this.state.setupInstance = undefined;
    if (!this.bridge.message) {
      this.state.setupInstance = target;
      this.state.errors.switch = "This host cannot send a switch request. Use the setup instructions below, then ask the conversation to open that connection's fleet.";
      this.emit();
      return;
    }
    this.busy("switch", true);
    try {
      const result = await this.bridge.message(switchPrompt(target));
      if (object(result).isError) throw new Error("The host could not deliver the switch request. Use the setup instructions below.");
      this.state.switchTarget = target;
      this.state.instanceDialog = false;
      this.state.notice = `Opening ${target.label} in the conversation. This console still shows ${this.state.connection?.endpoint ?? "its originating connection"} until the target opens in a new console.`;
    } catch (error) {
      this.state.setupInstance = target;
      this.state.errors.switch = errorText(error);
    }
    finally { this.busy("switch", false); }
  }

  stayOnInstance() {
    this.state.switchTarget = undefined;
    this.state.notice = "This console continues on its originating instance.";
    delete this.state.errors.switch;
    this.emit();
  }

  private applyApplications(result: Json, append: boolean) {
    const data = object(result.data ?? result);
    const incoming = array(data.applications);
    const merged = append ? [...this.state.applications, ...incoming] : incoming;
    this.state.applications = [...new Map(merged.map((item) => [JSON.stringify(identity(item)), item])).values()];
    this.state.total = number(data.total);
    this.state.cursor = string(field(data, "nextCursor") ?? result.nextCursor);
  }

  async search(namespace: string, search: string, append = false) {
    const request = ++this.fleetRequest;
    this.state.namespace = namespace;
    this.state.search = search;
    this.busy("fleet", true);
    try {
      const result = payload(await this.bridge.call(append ? "list_applications" : "open_fleet", { namespace, search, page_size: 50, ...(append && this.state.cursor ? { cursor: this.state.cursor } : {}) }));
      if (request !== this.fleetRequest) return;
      if (append) this.applyApplications(result, true);
      else {
        if (!this.acceptConnection(result.connection)) return;
        this.state.fleet = object(result.fleet);
        this.applyApplications(object(result.applications), false);
        this.state.observedAt = string(result.observedAt, new Date().toISOString());
      }
    } catch (error) { if (request === this.fleetRequest) this.state.errors.fleet = errorText(error); }
    finally { if (request === this.fleetRequest) this.busy("fleet", false); }
  }

  async refreshFleet() {
    // A scoped launch preserves the same namespace for the status summary
    // and list; it is an explicit refresh, not an initialization.
    await this.search(this.state.namespace, this.state.search);
  }

  private resetSelection(selected?: { name: string; namespace: string }) {
    this.selection++;
    this.state.selected = selected;
    this.state.health = undefined;
    this.state.tree = undefined;
    this.state.investigation = undefined;
    this.state.logs = undefined;
    this.state.logResource = undefined;
    this.state.tab = "health";
    this.state.notice = "";
    this.state.busy = new Set([...this.state.busy].filter((key) => ["fleet", "identity", "switch"].includes(key)));
    this.state.errors = Object.fromEntries(Object.entries(this.state.errors).filter(([key]) => ["fleet", "connection", "identity", "instance", "switch"].includes(key)));
  }

  overview() {
    this.resetSelection();
    this.emit();
  }

  async select(selected: { name: string; namespace: string }) {
    if (!selected.name || !selected.namespace) return;
    this.resetSelection(selected);
    await this.refreshHealth();
  }

  async refreshHealth() {
    await this.selectedRequest("health", "get_application_health", { resource_limit: 100, release_limit: 8 }, (result) => this.state.health = result);
  }

  async tab(tab: Tab) {
    this.state.tab = tab;
    this.emit();
    if (tab === "resources" && !this.state.tree && !this.state.busy.has("resources")) await this.resources();
  }

  async resources() {
    await this.selectedRequest("resources", "get_resource_tree", { detailed: true }, (result) => this.state.tree = result);
  }

  async investigate() {
    const selected = this.state.selected;
    if (!selected) return;
    this.state.tab = "debug";
    await this.selectedRequest("investigation", "investigate", { application_name: selected.name, application_namespace: selected.namespace }, (result) => this.state.investigation = result, false);
  }

  async logs(resource: Json) {
    const selected = this.state.selected;
    if (!selected || !["Deployment", "StatefulSet", "DaemonSet", "Pod", "Job"].includes(string(resource.kind))) return;
    this.state.tab = "debug";
    this.state.logResource = resource;
    this.state.logs = undefined;
    await this.selectedRequest("logs", "get_logs", {
      kind: "resource", tail_lines: 200,
      application_name: selected.name, application_namespace: selected.namespace,
      resource_kind: resource.kind, resource_name: resource.name,
      resource_namespace: string(resource.namespace, selected.namespace),
    }, (result) => {
      this.state.logs = result;
      if (result.error) this.state.errors.logs = string(result.error);
    }, false);
  }

  private async selectedRequest(key: string, name: string, args: Json, apply: (data: Json) => void, identityArgs = true) {
    const selected = this.state.selected;
    if (!selected) return;
    const generation = this.selection;
    const request = (this.requests.get(key) ?? 0) + 1;
    this.requests.set(key, request);
    const current = () => generation === this.selection && this.requests.get(key) === request;
    this.busy(key, true);
    try {
      const result = payload(await this.bridge.call(name, identityArgs ? { ...selected, ...args } : args));
      if (current()) apply(result);
    } catch (error) { if (current()) this.state.errors[key] = errorText(error); }
    finally { if (current()) this.busy(key, false); }
  }

  async attach() {
    const selected = this.state.selected;
    if (!selected || !this.bridge.context) return;
    this.busy("context", true);
    try {
      await this.bridge.context({
        content: [{ type: "text", text: `Selected Paprika application: ${selected.namespace}/${selected.name}. Instance: ${this.state.connection?.endpoint ?? "unverified originating MCP connection"}. Health evidence is a point-in-time observation from this instance only; verify the endpoint and refresh before taking action.` }],
        structuredContent: { connection: this.state.connection ? { endpoint: this.state.connection.endpoint, origin: this.state.connection.origin, verified: true } : { verified: false }, application: selected, status: object(this.state.health?.status), observedAt: string(this.state.health?.observedAt) },
      });
      this.state.notice = "Application attached to this conversation.";
    } catch (error) { this.state.errors.context = errorText(error); }
    finally { this.busy("context", false); }
  }

  async ask(action: "debug" | "sync") {
    const selected = this.state.selected;
    if (!selected || !this.bridge.message) return;
    if (this.state.busy.has("switch") || this.state.switchTarget) {
      this.state.errors.message = "Another instance is opening. Choose Stay here to continue requests on this console's instance.";
      this.emit();
      return;
    }
    if (action === "sync" && !this.state.connection) {
      this.state.errors.message = "Verify the originating instance before requesting a sync.";
      this.emit();
      return;
    }
    this.busy("message", true);
    try {
      const scope = this.state.connection
        ? ` Use only the Paprika connection whose get_connection endpoint is exactly ${this.state.connection.endpoint}; verify it before acting and do not fall back to another instance.`
        : " The originating instance is unverified. Ask me to identify the exact endpoint and verify get_connection before using any evidence or taking action; do not infer a deployment from the application name.";
      const delivered = await this.bridge.message(action === "debug"
        ? `Investigate Paprika application ${selected.namespace}/${selected.name}.${scope} Refresh health evidence, explain the cause of any failing health checks or drift, and recommend concrete next steps.`
        : `Sync Paprika application ${selected.namespace}/${selected.name}.${scope} If write access is required, use this connection's native OAuth flow with paprika:read and paprika:write. Then check its release and health on the same instance. Report the observed result and any blockers.`);
      if (object(delivered).isError) throw new Error("The host could not deliver the request. Send the same request in the conversation.");
      this.state.notice = action === "debug" ? "Investigation requested in the conversation." : "Sync requested in the conversation.";
    } catch (error) { this.state.errors.message = errorText(error); }
    finally { this.busy("message", false); }
  }

  get supportsContext() { return Boolean(this.bridge.context); }
  get supportsMessage() { return Boolean(this.bridge.message); }
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : "Paprika could not complete this request.";
