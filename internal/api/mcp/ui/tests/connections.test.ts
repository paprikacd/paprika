import assert from "node:assert/strict";
import test from "node:test";
import { endpoint, exampleInstances, parseConnection, parseInstance, readInstances, setupCommands, storageKey, switchPrompt, writeInstances } from "../src/connections.ts";
import { connection } from "./fixtures.ts";

test("public endpoints reject credentials, unsafe hostnames, transport changes and URL tricks", () => {
  assert.equal(endpoint("https://PAPRIKA.example.com/mcp"), "https://paprika.example.com/mcp");
  assert.equal(endpoint("https://paprika.example.com/team/mcp"), "https://paprika.example.com/team/mcp");
  assert.equal(endpoint("http://127.0.0.1:3000/mcp", true), "http://127.0.0.1:3000/mcp");
  for (const value of ["http://paprika.example.com/mcp", "https://token@paprika.example.com/mcp", "https://paprika.example.com/mcp?token=secret", "https://paprika.example.com/mcp#secret", "https://paprika.example.com/other", "https://paprika.example.com/team/../mcp", "https://paprika.example.com/%6dcp", "https://paprika.example.com/mcp/", "https://$(id).example.com/mcp", "https://paprika;id.example.com/mcp", "https://a_b.example.com/mcp", "https://paprika.example.com/a;id/mcp", "https://paprika.example.com\\mcp", "https://paprika.example.com//mcp"]) assert.equal(endpoint(value), undefined, value);
});

test("saved preferences strip credentials and account metadata, and ignore malformed versions and entries", () => {
  let stored = "";
  const storage = { getItem: () => stored || null, setItem: (key: string, value: string) => { assert.equal(key, storageKey); stored = value; } };
  const instance = { label: "Work", connection: "paprika_work", endpoint: "https://paprika.example.com/mcp", token: "never-store", account: { email: "private@example.test" } };
  assert.equal(writeInstances(storage, [instance]), true);
  assert.deepEqual(JSON.parse(stored), { version: 1, instances: [{ label: "Work", connection: "paprika_work", endpoint: "https://paprika.example.com/mcp" }] });
  assert.equal(readInstances(storage).instances.length, 3);
  stored = JSON.stringify({ version: 1, instances: [{ ...instance, endpoint: "https://secret@paprika.example.com/mcp" }, { ...instance, connection: "bad;alias" }] });
  assert.deepEqual(readInstances(storage).instances, exampleInstances);
  stored = JSON.stringify({ version: 2, instances: [instance] });
  assert.deepEqual(readInstances(storage).instances, exampleInstances);
  assert.equal(parseInstance({ ...instance, connection: "paprika work" }), undefined);
});

test("blocked storage retains session preferences without throwing or claiming persistence", () => {
  const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readInstances(storage).unavailable, true);
  assert.deepEqual(readInstances(storage).instances, exampleInstances);
  assert.equal(writeInstances(storage, exampleInstances), false);
  assert.equal(writeInstances(undefined, exampleInstances), false);
});

test("server identity cross-checks the public origin and only retains public account fields", () => {
  const parsed = parseConnection({ ...connection, account: { name: "Operator", email: "operator@example.test", id: "private-subject" }, token: "never-retain" });
  assert.deepEqual(parsed?.account, { name: "Operator", email: "operator@example.test" });
  assert.equal("token" in parsed!, false);
  assert.equal(parseConnection({ ...connection, origin: "https://paprika.starfleethub.com" }), undefined);
  assert.equal(parseConnection({ ...connection, endpoint: "https://paprika.benebsworth.com/mcp?token=secret" }), undefined);
  assert.equal(parseConnection({ ...connection, endpoint: "https://paprika.benebsworth.com/team/mcp" })?.origin, "https://paprika.benebsworth.com");
});

test("switch instructions name the exact native connection and verify the target before opening", () => {
  const target = exampleInstances[1];
  assert.match(switchPrompt(target), /get_connection.*exactly https:\/\/paprika\.starfleethub\.com\/mcp.*open_fleet/);
  assert.match(switchPrompt(target), /Do not use another connection/);
  assert.match(switchPrompt(target), /native OAuth with paprika:read/);
  assert.equal(setupCommands(target), "codex mcp add paprika_starfleethub --url 'https://paprika.starfleethub.com/mcp'\ncodex mcp login paprika_starfleethub --scopes paprika:read");
});
