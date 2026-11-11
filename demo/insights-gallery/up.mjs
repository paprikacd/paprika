#!/usr/bin/env node
// One command for the real-provider gallery: start.py (isolated Docker providers),
// a loopback static UI export, and serve.mjs with a 12-hour session. The browser
// reaches the proxy without a credential; the bearer token stays inside serve.mjs
// and is never written to the printed output or to the environment file.
//
//   node demo/insights-gallery/up.mjs            # from the repository root
//   node demo/insights-gallery/up.mjs --rebuild-ui
//
// Ctrl-C, SIGTERM or SIGHUP stops the proxy, the harness, the static server and
// this run's containers, then removes this run's credential files and serve
// state. The synthetic Prometheus volume is kept (see demo/insights-gallery/README.md).
// A later start recovers the records of an earlier run that did not exit cleanly.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunSupervisor, recoverOrphans } from "../../ui/e2e/fixtures/lab-process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const uiDirectory = join(root, "ui");
const uiExport = join(uiDirectory, "out");
const recordDirectory = join(root, "artifacts/insights/runs");
const allowedRoots = [join(root, "artifacts"), tmpdir()];
const tool = "insights-gallery";
const sessionDuration = "12h";
const rebuildUI = process.argv.includes("--rebuild-ui");
const log = message => console.error(message);
const supervisor = createRunSupervisor({ tool, recordDirectory, allowedRoots, log });
let stateDirectory;

function fail(message) {
  throw new Error(message);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitFor(check, label, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 250));
  }
  fail(`Timed out waiting for ${label}`);
}

// Keeps the last bytes of a child's stderr for a failure message.
function tail(child) {
  const state = { text: "" };
  child.stderr?.on("data", data => { state.text = (state.text + data).slice(-8000); });
  return state;
}

async function ensureUI() {
  if (!rebuildUI && await exists(join(uiExport, "index.html"))) {
    console.log(`Reusing the static UI export at ${uiExport} (pass --rebuild-ui to rebuild).`);
    return;
  }
  console.log("Building the static UI export (plain npm run build)…");
  const build = supervisor.spawnChild("npm run build", "npm", ["run", "build"], { cwd: uiDirectory, stdio: "inherit" });
  const [code] = await once(build, "exit");
  if (code !== 0) fail(`npm run build failed with exit code ${code}`);
}

async function startStaticUI(port) {
  const server = supervisor.spawnChild("static UI", "python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", uiExport], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  await waitFor(async () => {
    if (server.exitCode !== null || server.signalCode !== null) fail("The static UI server exited");
    return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false);
  }, "the static UI server", 20);
}

// start.py prints its state directory first, then runs for several minutes.
// Mirror its output while capturing the one path this command needs.
async function startProviders() {
  const start = supervisor.spawnChild("start.py", "python3", [join(here, "start.py")], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let buffered = "";
  start.stdout.on("data", data => {
    process.stdout.write(data);
    buffered += data;
    const match = /^Local state: (.+)$/m.exec(buffered);
    if (match && !stateDirectory) {
      stateDirectory = match[1].trim();
      // Recorded before the containers are relied on, so recovery can stop them.
      supervisor.addCommand("stop gallery containers", "python3", [join(here, "stop.py"), stateDirectory]);
      supervisor.addRemovePath(join(stateDirectory, "providers.json"));
      supervisor.addRemovePath(join(stateDirectory, "postgres.env"));
    }
  });
  const [code] = await once(start, "exit");
  if (code !== 0) fail(`start.py failed with exit code ${code}`);
  if (!stateDirectory) fail("start.py did not report its state directory");
  return join(stateDirectory, "providers.json");
}

async function startProxy(providersFile, uiURL) {
  const receiptFile = join(stateDirectory, "gallery-receipt.json");
  const proxy = supervisor.spawnChild("gallery proxy", process.execPath, ["--experimental-strip-types", join(here, "serve.mjs"), `--providers=${providersFile}`, `--ui-url=${uiURL}`, `--ready-file=${receiptFile}`, `--session-duration=${sessionDuration}`], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  const diagnostic = tail(proxy);
  let receipt;
  await waitFor(async () => {
    if (proxy.exitCode !== null || proxy.signalCode !== null) fail(`The gallery proxy exited (${proxy.exitCode ?? proxy.signalCode}). Last output:\n${diagnostic.text.trim().split("\n").slice(-12).join("\n")}`);
    if (!await exists(receiptFile)) return false;
    try { receipt = JSON.parse(await readFile(receiptFile, "utf8")); return true; } catch (error) {
      // serve.mjs renames a complete file into place; retry only defensively.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, "the gallery proxy", 900);
  proxy.once("exit", (code, signal) => {
    if (!supervisor.stopping) supervisor.requestShutdown(1, `gallery proxy stopped (${code ?? signal})`);
  });
  supervisor.addRemovePath(receiptFile);
  supervisor.addRemovePath(receipt.state);
  return receipt;
}

async function writeEnvironment(receipt, uiURL, receiptFile, providersFile) {
  // URLs and file paths only. The token never enters this file, and the providers
  // file it names is the private, mode-0600 file start.py already wrote.
  const path = join(stateDirectory, "gallery-env.sh");
  const body = [
    "# Written by demo/insights-gallery/up.mjs for this run. Synthetic data; no bearer token.",
    `export INSIGHTS_E2E_URL='${uiURL}'`,
    `export PAPRIKA_GALLERY_BASE_URL='${receipt.url}'`,
    `export PAPRIKA_GALLERY_READY='${receiptFile}'`,
    `export PAPRIKA_GALLERY_PROVIDERS='${providersFile}'`,
    "",
  ].join("\n");
  await writeFile(path, body, { mode: 0o600 });
  supervisor.addRemovePath(path);
  return path;
}

async function main() {
  await recoverOrphans({ tool, recordDirectory, allowedRoots, log });
  await ensureUI();
  const uiPort = await freePort();
  const uiURL = `http://127.0.0.1:${uiPort}/`;
  await startStaticUI(uiPort);
  const providersFile = await startProviders();
  const receipt = await startProxy(providersFile, uiURL);
  const receiptFile = join(stateDirectory, "gallery-receipt.json");
  const environment = await writeEnvironment(receipt, uiURL, receiptFile, providersFile);
  const dashboard = receipt.dashboards.includes("local-gallery-service-pulse") ? "local-gallery-service-pulse" : receipt.dashboards[0];
  const open = new URL(`dashboard/insights/?dashboard=${encodeURIComponent(dashboard)}`, receipt.url).href;
  console.log([
    "",
    `Gallery ready for ${sessionDuration} (synthetic data, no credentials in the browser or this output).`,
    "",
    `  Open: ${open}`,
    `  Receipt: ${receiptFile}`,
    `  Environment: source ${environment}`,
    "",
    "Stop: press Ctrl-C here. It stops the proxy, the harness, the containers and this run's credential files.",
    `From another shell (containers only): python3 demo/insights-gallery/stop.py ${stateDirectory}`,
    "",
  ].join("\n"));
}

supervisor.installSignalHandlers();
try {
  await main();
} catch (error) {
  log(error.message);
  await supervisor.requestShutdown(1, "startup failed");
}
