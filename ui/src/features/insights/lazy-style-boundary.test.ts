import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A lazy CSS module stays out of the first-view chunks only while every import of it comes right after its
// lazy-style-boundary import (see lazy-style-boundary.css). One importer without the pair lets Turbopack merge the
// module into a first-view chunk again.
const root = join(process.cwd(), "src/features/insights");
const boundary = join(root, "lazy-style-boundary.css");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

interface Line { file: string; number: number; text: string }

const boundaryImport = /^import "([^"?]+)\?([a-z0-9-]+)";?$/;
const moduleImport = /^import \w+ from "([^"]+\.module\.css)";?$/;
const files = sources(root);
const lines: Line[] = files.flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, index) => ({ file, number: index + 1, text: text.trim() })));
const at = (line: Line) => `${relative(root, line.file)}:${line.number}`;

// Every guarded module, keyed by its absolute path, with the query its boundary uses.
const guarded = new Map<string, string>();
for (const [index, line] of lines.entries()) {
  const match = boundaryImport.exec(line.text);
  if (!match || resolve(dirname(line.file), match[1]) !== boundary) continue;
  const next = lines[index + 1];
  const target = next?.file === line.file ? moduleImport.exec(next.text) : null;
  if (!target) throw new Error(`${at(line)}: a boundary import must come right before the CSS module it guards`);
  guarded.set(resolve(dirname(line.file), target[1]), match[2]);
}

describe("lazy style boundaries", () => {
  it("guards some lazy stylesheets", () => {
    expect(guarded.size).toBeGreaterThan(10);
  });

  it("names each guarded module with its own query", () => {
    const queries = [...guarded.entries()].map(([path, query]) => [query, path.split("/").pop()!.replace(/\.module\.css$/, "")]);
    for (const [query, name] of queries) expect(query, `query for ${name}`).toBe(name);
    expect(new Set(queries.map(([query]) => query)).size).toBe(queries.length);
  });

  it("puts the boundary before every import of a guarded module", () => {
    const missing: string[] = [];
    for (const [index, line] of lines.entries()) {
      const match = moduleImport.exec(line.text);
      if (!match) continue;
      const query = guarded.get(resolve(dirname(line.file), match[1]));
      if (!query) continue;
      const previous = boundaryImport.exec(index > 0 && lines[index - 1].file === line.file ? lines[index - 1].text : "");
      if (previous?.[2] !== query) missing.push(at(line));
    }
    expect(missing).toEqual([]);
  });
});
