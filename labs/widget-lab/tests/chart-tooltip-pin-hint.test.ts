import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ObservationTooltip renders production's keep-open footer by default. The lab's
// inspectors already carry their own Pin, Unpin and Close actions, so the lab
// wrapper must opt out or every lab popup gains a footer it never had.
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('lab chart tooltip', () => {
  it('opts out of the production pin hint', () => {
    const source = readFileSync(join(root, 'src/renderer-extensions/chart-tooltip.tsx'), 'utf8');
    expect(source).toMatch(/<ObservationTooltip[^>]*\spinHint=\{false\}/);
  });
});
