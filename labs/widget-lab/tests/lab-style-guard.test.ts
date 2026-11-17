import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The lab's shells, studies and reference views must stay on production's Gamma contract:
// no redefined density ramp or motion tokens, no ambient glow, no forced theme, no parallel palette.
// src/charts and src/renderer-extensions are governed by their own packages and are not scanned.
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const EXCLUDED = [/[\\/]charts[\\/]/, /[\\/]renderer-extensions[\\/]/];

function sourceFiles(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path, pattern);
    return pattern.test(name) && !EXCLUDED.some(excluded => excluded.test(path)) ? [path] : [];
  });
}

const cssFiles = () => sourceFiles(SRC, /\.css$/);
const sourceTextFiles = () => sourceFiles(SRC, /\.(tsx?|css)$/);
const read = (path: string) => readFileSync(path, 'utf8');
const offenders = (files: string[], pattern: RegExp) => files.filter(file => pattern.test(read(file))).map(file => file.slice(SRC.length + 1));

describe('lab Gamma discipline', () => {
  it('redefines no production density ramp, chart-empty, chart-hatch, duration or motion token', () => {
    expect(offenders(cssFiles(), /(^|[{;\s])--gamma-(density-\d+|chart-empty|chart-hatch|duration[\w-]*|motion[\w-]*)\s*:/m)).toEqual([]);
  });

  it('draws no ambient radial shell and no drop-shadow glow in lab CSS', () => {
    expect(offenders(cssFiles(), /radial-gradient\(|drop-shadow\(/)).toEqual([]);
  });

  it('keeps lab CSS free of literal hex colours: every colour is a Gamma token', () => {
    expect(offenders(cssFiles(), /#[0-9a-fA-F]{3,8}\b/)).toEqual([]);
  });

  it('defines no --ref palette; the reference studies use Gamma tokens', () => {
    const reference = sourceFiles(join(SRC, 'reference'), /\.css$/);
    expect(offenders(reference, /(^|[{;\s])--ref-(?!layout-width)[\w-]+\s*:/m)).toEqual([]);
  });

  it('forces no dark theme; every scope follows the resolved appearance', () => {
    expect(offenders(sourceTextFiles(), /data-insights-theme="dark"/)).toEqual([]);
  });

  it('retires the invented motion helper; motion reaches Gamma through data-motion', () => {
    expect(offenders(sourceTextFiles(), /labMotionStyle/)).toEqual([]);
  });
});
