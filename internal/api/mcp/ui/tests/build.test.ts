import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("the production console embeds the real Paprika icon without fetching an image", async () => {
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))]);
  const [html, packaged, brand] = await Promise.all([
    readFile(new URL("../dist/console.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/paprika-mark.png", import.meta.url)),
    readFile(new URL("../../../../../ui/src/app/icon.png", import.meta.url)),
  ]);
  assert.deepEqual(packaged, brand, "use the existing optimized capsicum mark");
  const embedded = html.match(/data:image\/png;base64,([a-zA-Z0-9+/=]+)/);
  assert.ok(embedded, "the mark must be available inside the standalone resource");
  assert.deepEqual(Buffer.from(embedded[1], "base64"), brand);
  assert.doesNotMatch(html, /<(?:img|script)\b[^>]*\bsrc=["'](?:https?:)?\/\//);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=["'](?:https?:)?\/\//);
});
