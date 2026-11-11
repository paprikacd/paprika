#!/usr/bin/env node
// First-view size budget for the Insights page, measured on the static export.
//
// The first view is the scripts and stylesheets in out/dashboard/insights/index.html (excluding
// legacy nomodule scripts) plus the chunks that InsightsApp loads through its dynamic import, as listed by
// Next's react-loadable manifest for the page. Run after `npm run build`:
//
//   node scripts/check-insights-budget.mjs            # check budgets, exit 1 when exceeded
//   node scripts/check-insights-budget.mjs --report   # print the breakdown only
//   node scripts/check-insights-budget.mjs --out <dir> --next <dir>
//
// Budgets are the measured size plus about 10% headroom. Raise one only in the change that adds the weight.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const BUDGET = {
  // Measured after the map land outline moved out of the first view.
  jsRaw: 2_557_000, // measured 2,323,640 bytes
  jsGzip: 733_000, // measured 666,191 bytes (Node zlib, level 9)
  // Insights-specific stylesheets only; the global root sheets are excluded.
  cssRaw: 293_000, // measured 265,715 bytes
  cssGzip: 45_000, // measured 40,191 bytes
};

function fail(message) {
  console.error(`Insights budget check: ${message}`);
  process.exit(1);
}

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const report = args.includes("--report");
const outIndex = args.indexOf("--out");
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : join(uiRoot, "out"));
const nextIndex = args.indexOf("--next");
const nextDir = resolve(nextIndex >= 0 ? args[nextIndex + 1] : join(uiRoot, ".next"));

// Maps an emitted URL (with or without a basePath prefix) to its path under out/_next.
// Loader chunk lists name assets relative to _next/ already.
function assetKey(url) {
  const at = url.indexOf("_next/");
  if (at >= 0) return url.slice(at + "_next/".length);
  if (url.startsWith("static/")) return url;
  fail(`Unexpected asset URL: ${url}`);
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]+)"`).exec(tag);
  return match ? match[1] : undefined;
}

function firstViewFromHtml(html) {
  const scripts = [];
  const styles = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    const src = attr(tag, "src");
    if (src && !/\snoModule\b/.test(tag)) scripts.push(assetKey(src));
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const href = attr(tag, "href");
    if (href && /\srel="stylesheet"/.test(tag)) styles.push(assetKey(href));
  }
  return { scripts, styles };
}

// Next writes the chunk list each next/dynamic() call loads to the page's react-loadable manifest, keyed by the
// module id. The Insights page has one dynamic import (InsightsApp), so every listed file belongs to it.
function insightsChunkGroup() {
  const manifestPath = join(nextDir, "server", "app", "dashboard", "insights", "page", "react-loadable-manifest.json");
  if (!existsSync(manifestPath))
    fail(`Missing ${manifestPath}. Run npm run build in ui/ first, or pass --next <dir>.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = Object.values(manifest).flatMap((entry) => entry.files ?? []).map(assetKey);
  if (!files.length) fail(`${manifestPath} lists no chunks for the Insights page; the dynamic import may have moved.`);
  return [...new Set(files)];
}

function sizeOf(key) {
  const path = join(out, "_next", key);
  if (!existsSync(path)) fail(`Missing build asset: ${path}`);
  const bytes = readFileSync(path);
  return { key, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
}

const indexPath = join(out, "dashboard", "insights", "index.html");
if (!existsSync(indexPath)) fail(`Missing ${indexPath}. Run npm run build in ui/ first.`);
const rootStyles = new Set(firstViewFromHtml(readFileSync(join(out, "index.html"), "utf8")).styles);
const page = firstViewFromHtml(readFileSync(indexPath, "utf8"));
const loaded = insightsChunkGroup();

const scriptKeys = [...new Set([...page.scripts, ...loaded.filter((key) => key.endsWith(".js"))])];
const styleKeys = [...new Set([...page.styles, ...loaded.filter((key) => key.endsWith(".css"))])];
const scripts = scriptKeys.map(sizeOf);
const styles = styleKeys.map((key) => ({ ...sizeOf(key), global: rootStyles.has(key) }));

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const totals = {
  jsRaw: sum(scripts, "raw"),
  jsGzip: sum(scripts, "gzip"),
  cssRaw: sum(styles.filter((row) => !row.global), "raw"),
  cssGzip: sum(styles.filter((row) => !row.global), "gzip"),
};

const pad = (text, width) => String(text).padEnd(width);
const num = (value) => value.toLocaleString("en-US").padStart(10);
console.log(`Insights first view (${out})`);
console.log(`${pad("kind", 6)}${pad("raw", 11)}${pad("gzip", 11)}file`);
for (const row of [...scripts.map((r) => ({ ...r, kind: "js" })), ...styles.map((r) => ({ ...r, kind: r.global ? "css-global" : "css" }))]) {
  console.log(`${pad(row.kind, 6)}${num(row.raw)} ${num(row.gzip)}  ${row.key}`);
}
console.log("");

const checks = [
  ["Insights first-view JS raw", totals.jsRaw, BUDGET.jsRaw],
  ["Insights first-view JS gzip", totals.jsGzip, BUDGET.jsGzip],
  ["Insights-specific CSS raw (excludes global)", totals.cssRaw, BUDGET.cssRaw],
  ["Insights-specific CSS gzip (excludes global)", totals.cssGzip, BUDGET.cssGzip],
];
let failed = false;
for (const [label, actual, budget] of checks) {
  const ok = actual <= budget;
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual.toLocaleString("en-US")} / budget ${budget.toLocaleString("en-US")}`);
}

if (failed && !report) {
  console.error("\nInsights first-view budget exceeded. Check for a static import that pulls the examples catalog or CodeMirror into the Insights entry, or a new eager dependency.");
  process.exit(1);
}
