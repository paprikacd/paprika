import assert from "node:assert/strict";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugin = new URL("../../../../../plugins/paprika/", import.meta.url);
const root = new URL("../../../../../", import.meta.url);
const endpoint = "https://paprika.benebsworth.com/mcp";
const prompts = [
  "Show fleet status and any unhealthy applications.",
  "Investigate the most recent failed release.",
  "What drifted out of sync on my apps?",
];

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL(path, plugin), "utf8"));
}

test("portable manifest and compatibility overlays preserve identity, prompts, and presentation", async () => {
  const [portable, codex, claude] = await Promise.all([
    json("plugin.json"), json(".codex-plugin/plugin.json"), json(".claude-plugin/plugin.json"),
  ]);
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  const allowed = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  for (const key of Object.keys(portable)) assert.ok(allowed.has(key), `nonportable manifest property: ${key}`);
  for (const manifest of [portable, codex, claude]) {
    assert.equal(manifest.name, "paprika");
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.description, portable.description);
    assert.equal(manifest.homepage, "https://paprika.benebsworth.com");
  }
  const presentation = portable.extensions["com.openai"].interface;
  assert.deepEqual(presentation, codex.interface);
  assert.equal(presentation.displayName, "Paprika");
  assert.ok(presentation.shortDescription.length > 0 && presentation.shortDescription.length <= 30);
  assert.ok(presentation.capabilities.includes("Interactive"));
  assert.deepEqual(presentation.defaultPrompt, prompts, "prompt values, type, and ordering are part of existing plugin identity");
  assert.equal(portable.extensions["com.openai"].apps, undefined);
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(claude.mcpServers, "./.mcp.json");
  assert.equal(codex.skills, "./skills/");
  assert.equal(claude.skills, "./skills/");
});

test("remote configurations use one endpoint and native authentication without embedded credentials", async () => {
  const [portable, compatibility] = await Promise.all([json("mcp.json"), json(".mcp.json")]);
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(portable).sort(), ["$schema", "mcpServers"]);
  assert.deepEqual(Object.keys(portable.mcpServers), ["paprika_hosted"]);
  assert.deepEqual(portable.mcpServers.paprika_hosted, { type: "streamable-http", url: endpoint });
  assert.deepEqual(compatibility.mcpServers.paprika_hosted, { type: "http", url: endpoint });
  assert.deepEqual(Object.keys(compatibility), ["mcpServers"]);
});

test("packaged icons are real contained PNG assets with usable dimensions", async () => {
  const manifest = await json("plugin.json");
  const presentation = manifest.extensions["com.openai"].interface;
  const directory = await realpath(plugin);
  for (const key of ["logo", "composerIcon"]) {
    assert.match(presentation[key], /^\.\/assets\//);
    const url = new URL(presentation[key], plugin);
    const resolved = await realpath(url);
    assert.ok(resolved.startsWith(`${directory}/`), "assets must stay inside the package even after resolving symlinks");
    const [bytes, info] = await Promise.all([readFile(url), stat(url)]);
    assert.ok(info.isFile() && info.size <= 5 * 1024 * 1024);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert.equal(width, height);
    assert.ok(width >= 48 && width <= 4096);
  }
});

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
};

function validateCall(args: Record<string, unknown>, schema: Schema, tool: string) {
  assert.equal(schema.type, "object", tool);
  for (const key of schema.required ?? []) assert.ok(Object.hasOwn(args, key), `${tool} requires ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    assert.ok(property || schema.additionalProperties !== false, `${tool} has no argument ${key}`);
    if (!property) continue;
    if (property.type === "integer") assert.ok(typeof value === "number" && Number.isInteger(value), `${tool}.${key} must be an integer`);
    else assert.equal(typeof value, property.type, `${tool}.${key}`);
    if (property.enum) assert.ok(property.enum.includes(value), `${tool}.${key} is outside its enum`);
    if (typeof value === "number") {
      if (property.minimum !== undefined) assert.ok(value >= property.minimum, `${tool}.${key} below minimum`);
      if (property.maximum !== undefined) assert.ok(value <= property.maximum, `${tool}.${key} above maximum`);
    }
  }
}

test("operational skill examples match the implemented tool schemas instead of obsolete aliases", async () => {
  const source = (await Promise.all(["tools_read.go", "diagnostics.go", "extensions.go", "connection.go"].map(
    (path) => readFile(new URL(path, new URL("../../", import.meta.url)), "utf8"),
  ))).join("\n");
  const schemas = new Map<string, Schema>();
  // Resource descriptors also have Name fields. Do not let one consume the
  // next tool's schema when scanning concatenated server source files.
  const pattern = /\bName:\s*"([^"]+)"(?:(?!\bName:\s*")[\s\S])*?\bInputSchema:\s*json\.RawMessage\(\s*`([^`]+)`\s*\)/g;
  for (const match of source.matchAll(pattern)) schemas.set(match[1], JSON.parse(match[2]));
  const skill = await readFile(new URL("skills/paprika/SKILL.md", plugin), "utf8");
  const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.ok(examples.length >= 7, "provide real inspection and debugging calls");
  for (const [, example] of examples) {
    const call = JSON.parse(example);
    const schema = schemas.get(call.tool);
    assert.ok(schema, `${call.tool} must exist in the actual server source`);
    validateCall(call.arguments, schema, call.tool);
  }
  assert.doesNotMatch(skill, /group_by|size_by|page\.page_token/);
  assert.match(skill, /get_application_health` first/);
  assert.match(skill, /status\.partial/);
  assert.match(skill, /identical arguments plus that token/);
});

test("skills have matching names and optional setup keeps OAuth and deployed-source boundaries explicit", async () => {
  const skills = await readdir(new URL("skills/", plugin), { withFileTypes: true });
  assert.deepEqual(skills.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), ["paprika", "paprika-setup"]);
  for (const entry of skills) {
    assert.ok(!entry.isSymbolicLink(), "skills must be contained source directories");
    if (!entry.isDirectory()) continue;
    const skill = await readFile(new URL(`skills/${entry.name}/SKILL.md`, plugin), "utf8");
    assert.match(skill, new RegExp(`^---\\nname: ${entry.name}\\n`));
    assert.match(skill, /\ndescription: .{50,}\n---/);
  }
  const [setup, guide, extensions] = await Promise.all([
    readFile(new URL("skills/paprika-setup/SKILL.md", plugin), "utf8"),
    readFile(new URL("docs/guides/mcp-plugin.md", root), "utf8"),
    readFile(new URL("../../extensions.go", import.meta.url), "utf8"),
  ]);
  assert.match(setup, /Use only when the user asks/);
  assert.match(setup, /native MCP OAuth/);
  assert.match(setup, /Do not ask for\npasted credentials/);
  assert.match(guide, /Source changes do not install\/reload a client plugin or upgrade the hosted/);
  assert.match(guide, /it does not prove the host rendered the panel or mention picker/);
  const resourceUri = extensions.match(/consoleResourceURI\s*=\s*"([^"]+)"/);
  assert.ok(resourceUri);
  assert.ok(guide.includes(`\`${resourceUri[1]}\``), "guide must document the actual registered console resource URI");
  assert.ok(fileURLToPath(plugin).endsWith("/plugins/paprika/"));
});
