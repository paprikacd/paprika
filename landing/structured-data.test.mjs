import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContent, readAnalyticsConfig } from './build-content.mjs';
import { jsonScript } from './structured-data.mjs';

test('embedded JSON-LD cannot terminate its script and preserves editorial text', () => {
  const value = { headline: '</script><script>alert("x")</script> & punctuation\u2028\u2029' };
  const script = jsonScript(value);
  assert.ok(!script.includes('<'));
  assert.ok(!/[\u2028\u2029]/.test(script));
  assert.deepEqual(JSON.parse(script), value);
});

test('a rebuild replaces homepage schema, decodes metadata and retains one analytics loader', () => {
  const destination = mkdtempSync(join(tmpdir(), 'paprika-schema-'));
  try {
    const homepage = join(destination, 'index.html');
    writeFileSync(homepage, '<html><head><title>Paprika &amp; Kubernetes</title><meta name="description" content="Read &quot;the docs&quot; &amp; deploy. Literal $&."/><!-- structured-data:start --><!-- structured-data:end --></head><body></body></html>');
    buildContent(destination);
    const first = readFileSync(homepage, 'utf8');
    buildContent(destination);
    assert.equal(readFileSync(homepage, 'utf8'), first, 'Repeated builds must not duplicate or mutate markup');
    const blocks = [...first.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const page = JSON.parse(blocks[0][1])['@graph'].find((entity) => entity['@type'] === 'WebPage');
    assert.equal(page.name, 'Paprika & Kubernetes');
    assert.equal(page.description, 'Read "the docs" & deploy. Literal $&.');
    assert.equal((first.match(/id="paprika-analytics"/g) || []).length, readAnalyticsConfig().siteId ? 1 : 0);
    writeFileSync(homepage, first.replace('<!-- structured-data:start -->', ''));
    assert.throws(() => buildContent(destination), /one structured-data placeholder/);
  } finally { rmSync(destination, { recursive: true, force: true }); }
});
