// Local-only demo host: real Paprika Insights/Observe + isolated providers.
// The loopback proxy supplies an ephemeral test token server-side, never to
// the browser. The data and provider file are user-selected local fixtures.
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { galleryDocuments } from "./dashboards.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--([a-z-]+)=(.*)$/.exec(argument);
  if (!match) throw Error("Use --providers=PATH --ui-url=URL [--ready-file=PATH]");
  return [match[1], match[2]];
}));
if (!args.providers || !args["ui-url"]) throw Error("A private provider file and local static UI URL are required");
const ui = new URL(args["ui-url"]);
if (!['127.0.0.1', 'localhost', '::1'].includes(ui.hostname) || !['http:', 'https:'].includes(ui.protocol)) throw Error("UI must be served from loopback");
const parent = resolve("artifacts/insights"); await mkdir(parent, { recursive: true });
const state = await mkdtemp(resolve(parent, "gallery-insights-"));
await import("node:fs/promises").then(fs => fs.chmod(state, 0o700));
const connectionFile = resolve(state, "private-connection.json"), data = resolve(state, "documents");
const child = spawn("go", ["run", "./hack/insights-observe-e2e", `--ready-file=${connectionFile}`, `--data-dir=${data}`, `--ui-url=${ui.href}`, "--application-fixtures", `--application-providers=${resolve(args.providers)}`], { stdio: ["ignore", "ignore", "pipe"] });
let diagnostic = ""; child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-8000); });
let connection;
try {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) throw Error(`Local Insights service exited (${child.exitCode}): ${diagnostic}`);
    try { connection = JSON.parse(await readFile(connectionFile, "utf8")); break; } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await new Promise(done => setTimeout(done, 200));
  }
  if (!connection) throw Error("Local Insights service did not become ready");
  const api = async (path, method = "GET", document, headers = {}) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await fetch(`${connection.baseURL}/api/insights/${path}`, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", ...headers }, ...(document ? { body: JSON.stringify(document) } : {}), signal: AbortSignal.timeout(30000) });
      const body = await response.text();
      // A 429 is an explicit rejection before execution. Preserve the exact
      // document and precondition; never retry network/ambiguous failures.
      if (response.status === 429 && attempt < 7) { await new Promise(done => setTimeout(done, Math.min(2500, 300 * (attempt + 1)))); continue; }
      if (!response.ok) throw Error(`${method} ${path} failed (${response.status}): ${body.slice(0, 800)}`);
      return body ? JSON.parse(body) : undefined;
    }
    throw Error(`${method} ${path} was repeatedly rate limited`);
  };
  const catalog = (await api("providers")).providers;
  const provider = (reference, kind) => {
    const value = catalog.find(item => item.providerRef === `observability/${reference}` && item.capabilities.includes(kind));
    if (!value) throw Error(`Local provider ${reference} is unavailable for ${kind}`);
    return value.id;
  };
  const documents = galleryDocuments({ metrics: provider("gallery-prometheus", "metrics"), traces: provider("gallery-tempo", "traces"), records: provider("gallery-postgresql", "records") });
  for (const query of documents.savedQueries) await api(`saved-queries/${encodeURIComponent(query.id)}`, "PUT", query, { "If-None-Match": "*" });
  for (const dashboard of documents.dashboards) await api(`dashboards/${encodeURIComponent(dashboard.id)}`, "PUT", dashboard, { "If-None-Match": "*" });
  const upstream = new URL(connection.baseURL);
  let port;
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403); return res.end("Local demo only"); }
    const headers = { ...req.headers, host: upstream.host };
    if (req.url?.startsWith("/api/insights/")) headers.authorization = `Bearer ${connection.token}`;
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Local demo service unavailable"); });
    req.pipe(proxy);
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  port = server.address().port;
  const receipt = { url: `http://127.0.0.1:${port}/`, state, dashboards: documents.dashboards.map(item => item.id), savedQueryCount: documents.savedQueries.length, syntheticData: true };
  if (args["ready-file"]) await writeFile(resolve(args["ready-file"]), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  const shutdown = () => { server.close(); child.kill("SIGTERM"); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  child.once("exit", () => server.close());
} catch (error) { child.kill("SIGTERM"); throw error; }
