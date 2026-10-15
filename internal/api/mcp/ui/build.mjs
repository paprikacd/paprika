import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const paprikaMark = await readFile("assets/paprika-mark.png");
const output = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
  outfile: "console.js",
  define: { __PAPRIKA_MARK_DATA_URI__: JSON.stringify(`data:image/png;base64,${paprikaMark.toString("base64")}`) },
});
const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
if (!script) throw new Error("Console script was not generated");
const css = await readFile("src/style.css", "utf8");
const extensionCSS = await readFile("node_modules/@openai/mcp-extensions/styles.css", "utf8");
await mkdir("dist", { recursive: true });
await writeFile("dist/console.html", `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paprika fleet</title><style>${extensionCSS}\n${css}</style></head><body>
<div id="console"><p class="starting" role="status">Connecting to Paprika…</p></div>
<script>${script.replaceAll("</script", "<\\/script")}</script></body></html>\n`);
console.log("Built dist/console.html (self-contained, no remote runtime dependencies)");
