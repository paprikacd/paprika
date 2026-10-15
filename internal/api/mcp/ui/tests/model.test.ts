import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleController, label, parseDeepLink, payload, resourceRows, tone, type Json, type ToolBridge } from "../src/model.ts";
import { render } from "../src/view.ts";
import { connection, health, launch, result, starfleetConnection, tree } from "./fixtures.ts";

function mock() {
  const calls: Array<{ name: string; args: Json }> = [];
  const bridge: ToolBridge = { call: async (name, args) => {
    calls.push({ name, args });
    if (name === "get_application_health") return result(health(String(args.name), String(args.namespace)));
    if (name === "get_resource_tree") return result(tree);
    if (name === "open_fleet") return result(launch);
    return result({});
  } };
  return { calls, bridge, controller: new ConsoleController(bridge) };
}

test("launch uses delivered fleet, selects attention app, and requests only bounded health", async () => {
  const { calls, controller } = mock();
  await controller.launch(result(launch));
  assert.deepEqual(calls, [{ name: "get_application_health", args: { name: "checkout-api", namespace: "production", resource_limit: 100, release_limit: 8 } }]);
  assert.equal(controller.state.applications.length, 3);
  assert.equal(controller.state.health?.status && (controller.state.health.status as Json).retriesExhausted, true);
});

test("fleet overview keeps the verified site and invalidates pending application evidence", async () => {
  const { controller, bridge } = mock();
  await controller.launch(result(launch));
  const fleet = controller.state.fleet;
  const applications = controller.state.applications;
  let deliver!: (value: unknown) => void;
  bridge.call = async () => new Promise((resolve) => { deliver = resolve; });
  const pending = controller.refreshHealth();
  controller.overview();
  assert.equal(controller.state.connection?.endpoint, connection.endpoint);
  assert.equal(controller.state.fleet, fleet);
  assert.equal(controller.state.applications, applications);
  assert.equal(controller.state.selected, undefined);
  assert.equal(controller.state.busy.has("health"), false);
  deliver(result(health()));
  await pending;
  assert.equal(controller.state.selected, undefined);
  assert.equal(controller.state.health, undefined);
});

test("resources, investigation, and logs require explicit actions with exact scoped arguments", async () => {
  const { calls, controller } = mock();
  await controller.launch(result(launch));
  await controller.tab("resources");
  assert.deepEqual(calls[1], { name: "get_resource_tree", args: { name: "checkout-api", namespace: "production", detailed: true } });
  await controller.investigate();
  assert.deepEqual(calls[2], { name: "investigate", args: { application_name: "checkout-api", application_namespace: "production" } });
  await controller.logs((tree.nodes as Json[])[0]);
  assert.deepEqual(calls[3], { name: "get_logs", args: { kind: "resource", tail_lines: 200, application_name: "checkout-api", application_namespace: "production", resource_kind: "Deployment", resource_name: "checkout-api", resource_namespace: "production" } });
  await controller.logs({ kind: "Secret", name: "credentials", namespace: "production" });
  assert.equal(calls.length, 4);
});

test("late health responses cannot replace another selected application's evidence", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const controller = new ConsoleController({ call: () => new Promise((resolve) => pending.push(resolve)) });
  const first = controller.select({ name: "old-app", namespace: "production" });
  const second = controller.select({ name: "new-app", namespace: "production" });
  pending[1](result(health("new-app"))); await second;
  pending[0](result(health("old-app"))); await first;
  assert.equal((controller.state.health?.identity as Json).name, "new-app");
  assert.equal(controller.state.busy.has("health"), false);
});

test("a superseded refresh for the same app cannot overwrite newer evidence", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const controller = new ConsoleController({ call: () => new Promise((resolve) => pending.push(resolve)) });
  const first = controller.select({ name: "checkout-api", namespace: "production" });
  const second = controller.refreshHealth();
  pending[1](result({ marker: "new" })); await second;
  pending[0](result({ marker: "old" })); await first;
  assert.equal(controller.state.health?.marker, "new");
});

test("namespace/search refresh keeps fleet and list scope aligned; next page uses cursor", async () => {
  const { calls, controller, bridge } = mock();
  bridge.call = async (name, args) => { calls.push({ name, args }); return name === "open_fleet" ? result({ ...launch, applications: { applications: (launch.applications as Json).applications, total: 8, nextCursor: "opaque" } }) : result({ data: { applications: [], total: 8, nextCursor: "" } }); };
  await controller.search("production", "api");
  await controller.search("production", "api", true);
  assert.deepEqual(calls, [{ name: "open_fleet", args: { namespace: "production", search: "api", page_size: 50 } }, { name: "list_applications", args: { namespace: "production", search: "api", page_size: 50, cursor: "opaque" } }]);
  assert.equal(controller.state.applications.length, 3);
  assert.equal(controller.state.cursor, "");
});

test("explicit context and sync controls attach bounded status or send host message, never call mutation", async () => {
  const { calls, controller, bridge } = mock();
  const context: Json[] = [], messages: string[] = [];
  bridge.context = async (args) => { context.push(args); };
  bridge.message = async (text) => { messages.push(text); };
  await controller.launch(result(launch));
  await controller.attach(); await controller.ask("sync");
  assert.equal(context.length, 1);
  assert.deepEqual((context[0].structuredContent as Json).application, { name: "checkout-api", namespace: "production" });
  assert.deepEqual((context[0].structuredContent as Json).connection, { endpoint: connection.endpoint, origin: connection.origin, verified: true });
  assert.equal((context[0].structuredContent as Json).logs, undefined);
  assert.match(messages[0], /Sync Paprika application production\/checkout-api/);
  assert.match(messages[0], /endpoint is exactly https:\/\/paprika\.benebsworth\.com\/mcp/);
  assert.deepEqual(calls.map((call) => call.name), ["get_application_health"]);
});

test("instance switching sends a host request while all evidence remains bound to the originating endpoint", async () => {
  const { calls, controller, bridge } = mock();
  const messages: string[] = [];
  bridge.message = async (text) => { messages.push(text); return {}; };
  await controller.launch(result(launch));
  const snapshot = controller.state.health;
  controller.manageInstances();
  await controller.switchInstance("paprika_starfleethub");
  assert.equal(controller.state.switchTarget?.endpoint, starfleetConnection.endpoint);
  assert.equal(controller.state.connection?.endpoint, connection.endpoint);
  assert.equal(controller.state.health, snapshot);
  assert.equal(controller.state.fleet, launch.fleet);
  assert.equal(controller.state.instanceDialog, false);
  assert.equal(controller.state.setupInstance, undefined);
  assert.match(messages[0], /paprika_starfleethub.*https:\/\/paprika\.starfleethub\.com\/mcp/);
  assert.deepEqual(calls.map((call) => call.name), ["get_application_health"]);
  await controller.ask("sync"); await controller.ask("debug");
  assert.equal(messages.length, 1);
  assert.match(controller.state.errors.message, /Choose Stay here/);
  controller.manageInstances(false);
  const html = render(controller.state, false, true);
  assert.match(html, /data-action="sync" disabled/);
  assert.match(html, /This view remains on https:\/\/paprika\.benebsworth\.com\/mcp/);
  controller.stayOnInstance();
  await controller.switchInstance("paprika_hosted");
  assert.equal(messages.length, 1);
  await controller.ask("debug");
  assert.match(messages[1], /endpoint is exactly https:\/\/paprika\.benebsworth\.com\/mcp/);
});

test("foreign identity cannot change an existing App's bound endpoint or replace its fleet evidence", async () => {
  const { controller, bridge } = mock();
  await controller.launch(result(launch));
  const previousFleet = controller.state.fleet;
  await controller.launch(result({ ...launch, connection: starfleetConnection, fleet: { total: 999 } }));
  assert.equal(controller.state.connection?.endpoint, connection.endpoint);
  assert.equal(controller.state.fleet, previousFleet);
  assert.match(controller.state.errors.identity, /different instance/);
  bridge.call = async () => result({ ...launch, connection: starfleetConnection, fleet: { total: 999 } });
  await controller.refreshFleet();
  assert.equal(controller.state.fleet, previousFleet);
});

test("malformed declared identities fail closed rather than attributing foreign evidence to a verified origin", async () => {
  const { controller, bridge } = mock();
  await controller.launch(result(launch));
  const previousFleet = controller.state.fleet;
  const malformed = { ...connection, origin: "https://paprika.starfleethub.com" };
  await controller.launch(result({ ...launch, connection: malformed, fleet: { total: 999 } }));
  assert.equal(controller.state.fleet, previousFleet);
  assert.match(controller.state.errors.identity, /invalid instance identity/);
  bridge.call = async () => result({ ...launch, connection: null, fleet: { total: 999 } });
  await controller.refreshFleet();
  assert.equal(controller.state.fleet, previousFleet);
});

test("application requests are blocked while a switch message is still being delivered", async () => {
  const { controller, bridge } = mock();
  let delivered!: (value: unknown) => void;
  let messageCount = 0;
  bridge.message = async () => { messageCount++; return new Promise((resolve) => { delivered = resolve; }); };
  await controller.launch(result(launch));
  const pending = controller.switchInstance("paprika_starfleethub");
  await controller.ask("sync");
  assert.equal(messageCount, 1);
  assert.match(render(controller.state, false, true), /data-action="sync" disabled/);
  delivered({}); await pending;
});

test("old launch data verifies get_connection, but a missing identity tool keeps sync disabled", async () => {
  const { controller, bridge, calls } = mock();
  bridge.call = async (name, args) => { calls.push({ name, args }); return name === "get_connection" ? result(connection) : result(health()); };
  await controller.launch(result({ ...launch, connection: undefined }));
  assert.equal(controller.state.connection?.endpoint, connection.endpoint);
  assert.deepEqual(calls.map((call) => call.name), ["get_connection", "get_application_health"]);
  const unverified = new ConsoleController({ call: async (name) => name === "get_connection" ? { isError: true, content: [{ type: "text", text: "Unknown tool get_connection" }] } : result(health()), message: async () => { throw new Error("must not send a mutation request"); } });
  await unverified.launch(result({ ...launch, connection: undefined }));
  assert.equal(unverified.state.connection, undefined);
  assert.ok(unverified.state.health);
  assert.match(render(unverified.state, false, true), /data-action="sync" disabled/);
  await unverified.ask("sync");
  assert.match(unverified.state.errors.message, /Verify the originating instance/);
});

test("unverified evidence is explicitly stamped and cannot silently select an instance for debugging", async () => {
  const contexts: Json[] = [], messages: string[] = [];
  const controller = new ConsoleController({ call: async () => result(health()), context: async (args) => { contexts.push(args); }, message: async (text) => { messages.push(text); } });
  await controller.select({ namespace: "production", name: "checkout-api" });
  await controller.attach(); await controller.ask("debug");
  assert.deepEqual((contexts[0].structuredContent as Json).connection, { verified: false });
  assert.match(JSON.stringify(contexts[0].content), /unverified originating MCP connection/);
  assert.match(messages[0], /unverified.*identify the exact endpoint/);
});

test("rejected switch requests stay actionable and never claim the target opened", async () => {
  const { controller, bridge } = mock();
  bridge.message = async () => ({ isError: true });
  await controller.launch(result(launch)); await controller.switchInstance("paprika_starfleethub");
  assert.equal(controller.state.switchTarget, undefined);
  assert.match(controller.state.errors.switch, /could not deliver/);
  assert.equal(controller.state.connection?.endpoint, connection.endpoint);
  controller.manageInstances();
  assert.match(render(controller.state, false, true), /codex mcp login paprika_starfleethub/);
});

test("hosts without message support show native setup and custom instances survive blocked storage for this session", async () => {
  const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const controller = new ConsoleController({ call: async () => result(health()) }, storage);
  assert.equal(controller.saveInstance({ label: "Work", connection: "paprika_work", endpoint: "https://paprika.example.test/mcp" }), true);
  assert.equal(controller.state.storageUnavailable, true);
  assert.equal(controller.state.instances.length, 3);
  await controller.switchInstance("paprika_work");
  assert.equal(controller.state.switchTarget, undefined);
  assert.match(controller.state.errors.switch, /cannot send/);
  controller.manageInstances();
  const html = render(controller.state, false, false);
  assert.match(html, /Browser storage is unavailable/);
  assert.match(html, /codex mcp login paprika_work/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  controller.removeInstance("paprika_work");
  assert.equal(controller.state.instances.length, 2);
});

test("tool errors remain errors instead of empty healthy data", async () => {
  assert.throws(() => payload({ isError: true, content: [{ type: "text", text: "forbidden" }] }), /forbidden/);
  const controller = new ConsoleController({ call: async () => ({ isError: true, content: [{ type: "text", text: "Health access denied" }] }) });
  await controller.select({ name: "checkout-api", namespace: "production" });
  assert.equal(controller.state.health, undefined);
  assert.match(render(controller.state, false, false), /role="alert">Health access denied/);
});

test("resources and debugging remain available when the combined health report fails", async () => {
  const controller = new ConsoleController({ call: async (name) => name === "get_resource_tree" ? result(tree) : { isError: true, content: [{ type: "text", text: "Health evidence unavailable" }] } });
  await controller.select({ name: "checkout-api", namespace: "production" });
  await controller.tab("debug");
  assert.match(render(controller.state, false, false), /Run investigation/);
  await controller.tab("resources");
  const html = render(controller.state, false, false);
  assert.match(html, /Candidate image cannot be pulled/);
  assert.match(html, /View logs/);
  assert.match(html, /role="alert">Health evidence unavailable/);
});

test("rejected host messages do not claim a sync request was delivered", async () => {
  const { controller, bridge } = mock();
  bridge.message = async () => ({ isError: true });
  await controller.launch(result(launch)); await controller.ask("sync");
  assert.equal(controller.state.notice, "");
  assert.match(controller.state.errors.message, /could not deliver/);
});

test("partial unknown evidence is visible and a failed release retains false readiness conditions", async () => {
  const { controller } = mock();
  await controller.select({ name: "payments-worker", namespace: "staging" });
  const partial = render(controller.state, false, false);
  assert.match(partial, /Some evidence is unavailable/);
  assert.match(partial, /No recorded managed resource evidence/);
  assert.match(partial, /Drift details are not configured/);
  await controller.select({ name: "checkout-api", namespace: "production" });
  await controller.tab("releases");
  assert.match(render(controller.state, false, false), /Candidate failed its readiness check/);
});

test("unknown/stale states are neutral, unsuccessful sync is not green, and group-less reports are not joined", () => {
  for (const state of ["Unknown", "FLEET_HEALTH_UNKNOWN", "stale", "not_available", ""]) assert.equal(tone(state), "neutral");
  assert.notEqual(tone("OutOfSync"), "success");
  const rows = resourceRows({ resources: { sync: { data: [{ kind: "Service", name: "same" }] }, health: { data: [{ kind: "Service", name: "same", health: "Healthy" }, { kind: "Service", name: "same", health: "Degraded" }] } } });
  assert.equal(rows.length, 3);
  assert.equal(label("OutOfSync"), "Out Of Sync");
  assert.equal(label("SEVERITY_CRITICAL"), "Critical");
});

test("app-relative host deep links accept only an exact valid application route", () => {
  assert.deepEqual(parseDeepLink("/applications/production/checkout-api"), { namespace: "production", name: "checkout-api" });
  assert.deepEqual(parseDeepLink("/applications/team-a/api.v2"), { namespace: "team-a", name: "api.v2" });
  for (const link of ["paprika://applications/team-a/api", "https://example.test/applications/team-a/api", "//applications/team-a/api", "/applications/team-a/../api", "/applications/team-a/%2e%2e", "/applications/team-a/api%2fother", "/applications/team-a/api?sync=1", "/applications/team-a/api#sync", "/applications/team-a/%", "/applications/UPPER/api", "/applications/team-a/api..other"]) assert.equal(parseDeepLink(link), undefined, link);
});

test("all untrusted names, findings and logs render as escaped text", async () => {
  const { controller } = mock(); await controller.launch(result(launch));
  controller.state.selected = { name: '<img src=x onerror="bad()">', namespace: "production" };
  controller.state.tab = "debug";
  controller.state.investigation = { findings: [{ title: "<script>bad()</script>", description: "<b>injected</b>", evidence: [] }] };
  controller.state.logs = { logs: '<img src=x onerror="bad()">' };
  const html = render(controller.state, true, true);
  assert.equal(html.includes("<script>bad()"), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
