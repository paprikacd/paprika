import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../../../", import.meta.url);
const plugin = new URL("plugins/paprika-observe/", root);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, plugin), "utf8"));
const endpoint = "https://paprika.benebsworth.com/observe/mcp";

test("observe is an optional separate package with consistent supported manifests", async () => {
  const [portable, codex, claude, mcp, compatibility] = await Promise.all([
    read("plugin.json"), read(".codex-plugin/plugin.json"), read(".claude-plugin/plugin.json"), read("mcp.json"), read(".mcp.json"),
  ]);
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  for (const manifest of [portable, codex, claude]) {
    assert.equal(manifest.name, "paprika-observe");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.description, portable.description);
  }
  assert.deepEqual(codex.interface, portable.extensions["com.openai"].interface);
  assert.deepEqual(codex.interface.capabilities, ["Read"]);
  for (const manifest of [codex, claude]) {
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(manifest.skills, "./skills/");
  }
  assert.deepEqual(compatibility, { mcpServers: { paprika_observe: { type: "http", url: endpoint } } });
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["paprika_observe"]);
  assert.deepEqual(mcp.mcpServers.paprika_observe, {
    type: "streamable-http", url: endpoint,
    extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" }, baseScopes: ["paprika:observe"] } } },
  });
  const fleet = JSON.parse(await readFile(new URL("plugins/paprika/.mcp.json", root), "utf8"));
  assert.deepEqual(Object.keys(fleet.mcpServers), ["paprika_hosted"], "updating the fleet package must not attach a new connection");
  const icon = await realpath(new URL(codex.interface.logo, plugin));
  assert.ok(icon.startsWith(`${await realpath(plugin)}/assets/`));
});

test("marketplaces expose observe as an independent opt-in plugin", async () => {
  for (const path of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const marketplace = JSON.parse(await readFile(new URL(path, root), "utf8"));
    assert.equal(marketplace.plugins.filter((p: any) => p.name === "paprika-observe").length, 1);
    assert.equal(marketplace.plugins.filter((p: any) => p.name === "paprika").length, 1);
  }
});

test("observe skill examples match real gateway schemas and preserve secure handoff boundaries", async () => {
  const source = await readFile(new URL("internal/observabilitygateway/tools.go", root), "utf8");
  const schemas = new Map<string, any>();
  for (const match of source.matchAll(/\bName:\s*"([^"]+)"(?:(?!\bName:\s*")[\s\S])*?\bInputSchema:\s*json\.RawMessage\(\s*`([^`]+)`\s*\)/g)) {
    schemas.set(match[1], JSON.parse(match[2]));
  }
  // query_metrics and query_logs are built by nativeQueryTool, whose tool name
  // is derived from the signal rather than a literal Name field.
  const nativeSource = source.slice(source.indexOf("func nativeQueryTool"), source.indexOf("func queryTracesTool"));
  const nativeSchema = nativeSource.match(/InputSchema:\s*json\.RawMessage\(fmt\.Sprintf\(\s*`([^`]+)`\s*,\s*metricFields\s*\)\)/);
  const metricFields = nativeSource.match(/metricFields\s*=\s*`([^`]+)`/);
  assert.ok(nativeSchema, "native query schema template must exist");
  assert.ok(metricFields, "metric-specific query options must exist");
  schemas.set("query_metrics", JSON.parse(nativeSchema[1].replace("%s", metricFields[1])));
  schemas.set("query_logs", JSON.parse(nativeSchema[1].replace("%s", "")));
  assert.equal(schemas.get("query_metrics").properties.step_seconds.type, "number");
  assert.equal(schemas.get("query_metrics").properties.instant.type, "boolean");
  assert.ok(!Object.hasOwn(schemas.get("query_logs").properties, "step_seconds"));
  const skill = await readFile(new URL("skills/paprika-observe/SKILL.md", plugin), "utf8");
  const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(examples.length >= 4);
  for (const [, raw] of examples) {
    for (const line of raw.split("\n").filter((entry) => entry.trim() !== "")) {
      const { tool, arguments: args } = JSON.parse(line), schema = schemas.get(tool);
      assert.ok(schema, `${tool} must exist`);
      for (const name of schema.required ?? []) assert.ok(Object.hasOwn(args, name));
      for (const [name, value] of Object.entries(args)) {
        assert.ok(Object.hasOwn(schema.properties, name), `${tool}.${name} must exist`);
        const field = schema.properties[name];
        assert.equal(typeof value, field.type === "integer" ? "number" : field.type);
        if (field.maximum !== undefined) assert.ok((value as number) <= field.maximum);
        if (field.minimum !== undefined) assert.ok((value as number) >= field.minimum);
      }
    }
  }
  assert.match(skill, /native OAuth/);
  assert.match(skill, /only when the user asks to connect or install that exact endpoint/);
  assert.match(skill, /offline; it does not test backend connectivity/);
  assert.match(skill, /do not invent pagination/);
  assert.match(skill, /Empty successful results/);
});
