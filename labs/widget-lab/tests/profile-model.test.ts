import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  decodeCollapsed, decodePyroscope, decodeSpeedscope, encodeFlamebearer,
  flamechartConfig, flamechartSpans, flamegraphConfig, formatProfileValue,
  parseProfileText, profileFromRecords, profileFromStacks, profileHotFunctions,
  profileToRecords, queryPlanConfig, samplesFromRecords, samplesToRecords,
  validateProfile, type Profile, type StackSample,
} from '../src/charts/profiling/profile-model';
import { parseQueryPlan } from '../src/charts/profiling/QueryPlan';
import { registerProfilingCharts } from '../src/charts/profiling/register';
import {
  buildProfileFixture, collapsedProfile, PROFILE_FIXTURES, QUERY_PLAN,
  speedscopeFile,
} from '../src/lenses/profiling/profile-fixtures';
import { makeProfilingCatalogFixture, profilingChartCatalog } from '../src/catalog/profiling-fixtures';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { widgetSchema } from '../src/renderer-extensions/schema';

// Both parents own self cost, so depth two contains a nonzero delta between leaves.
function accountingProfile(): Profile {
  return {
    name: 'Accounting fixture', source: 'Test observations', unit: 'samples', sampleRate: 100, total: 100,
    frames: [
      { id: 'root', parentId: null, label: 'total', depth: 0, start: 0, total: 100, self: 5 },
      { id: 'a', parentId: 'root', label: 'alpha', depth: 1, start: 5, total: 60, self: 15 },
      { id: 'a-leaf', parentId: 'a', label: 'work', depth: 2, start: 20, total: 45, self: 45 },
      { id: 'b', parentId: 'root', label: 'beta', depth: 1, start: 65, total: 35, self: 10 },
      { id: 'b-leaf', parentId: 'b', label: 'work', depth: 2, start: 75, total: 25, self: 25 },
    ],
  };
}

// Adapter IDs may change. Compare the actual ancestry, geometry, and costs instead.
function costs(profile: Profile) {
  const byId = new Map(profile.frames.map(frame => [frame.id, frame]));
  return profile.frames.map(frame => {
    const ancestry = [frame.label];
    let parent = frame.parentId ? byId.get(frame.parentId) : undefined;
    while (parent) { ancestry.unshift(parent.label); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
    return { ancestry, depth: frame.depth, start: frame.start, total: frame.total, self: frame.self };
  }).sort((a, b) => a.ancestry.join('/').localeCompare(b.ancestry.join('/')));
}

function simpleSpeedscope(unit = 'milliseconds', unitsPerMillisecond = 1) {
  return {
    name: 'Weighted sample test',
    shared: { frames: [{ name: 'main' }, { name: 'work' }] },
    profiles: [{
      type: 'sampled', name: 'worker', unit,
      startValue: 2 * unitsPerMillisecond, endValue: 5 * unitsPerMillisecond,
      samples: [[0, 1], [0], []] as number[][],
      weights: [1, 0, 2].map(value => value * unitsPerMillisecond),
    }],
  };
}

function temporalSamples(): StackSample[] {
  return [
    { id: 's0', thread: 'worker', start: 0, end: 10, stack: ['main', 'read'] },
    { id: 's1', thread: 'worker', start: 10, end: 20, stack: ['main', 'write'] },
    { id: 's2', thread: 'worker', start: 20, end: 30, stack: ['main', 'write'] },
    { id: 's3', thread: 'worker', start: 40, end: 50, stack: ['main', 'write'] },
  ];
}

describe('Pyroscope cost and ancestry adapters', () => {
  it('roundtrips Flamebearer delta offsets and repeated symbols under distinct parents', () => {
    const source = accountingProfile(), encoded = encodeFlamebearer(source);
    expect(encoded.flamebearer.levels[1].filter((_, index) => index % 4 === 0)).toEqual([5, 0]);
    expect(encoded.flamebearer.levels[2].filter((_, index) => index % 4 === 0)).toEqual([20, 10]);
    expect(encoded.flamebearer.names.filter(name => name === 'work')).toHaveLength(1);
    const decoded = decodePyroscope(encoded);
    expect(costs(decoded)).toEqual(costs(source));
    expect(decoded).toMatchObject({ name: source.name, unit: 'samples', sampleRate: 100, total: 100 });
    expect(new Set(decoded.frames.map(frame => frame.id)).size).toBe(decoded.frames.length);
  });

  it('decodes Querier integer strings without truncating safe integers', () => {
    const document = {
      flamegraph: {
        names: ['total'], total: String(Number.MAX_SAFE_INTEGER),
        levels: [{ values: ['0', String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER), '0'] }],
      },
    };
    const decoded = decodePyroscope(document);
    expect(decoded.total).toBe(Number.MAX_SAFE_INTEGER);
    expect(decoded.frames[0].self).toBe(Number.MAX_SAFE_INTEGER);
    expect(decoded.unit).toBe('nanoseconds');
    expect(decoded.sampleRate).toBe(1e9);
    document.flamegraph.total = '9007199254740992';
    expect(() => decodePyroscope(document)).toThrow(/safe number/);
  });

  it('rejects unsupported, malformed, and out-of-range Flamebearer imports', () => {
    const source = encodeFlamebearer(accountingProfile());
    const version = structuredClone(source); version.version = 2;
    expect(() => decodePyroscope(version)).toThrow(/version 1/);
    const differential = structuredClone(source); differential.metadata.format = 'double';
    expect(() => decodePyroscope(differential)).toThrow(/single/);
    const tuple = structuredClone(source); tuple.flamebearer.levels[1].pop();
    expect(() => decodePyroscope(tuple)).toThrow(/four values/);
    const symbol = structuredClone(source); symbol.flamebearer.levels[1][3] = 999;
    expect(() => decodePyroscope(symbol)).toThrow(/unknown symbol/);
    const negative = structuredClone(source); negative.flamebearer.levels[1][0] = -1;
    expect(() => decodePyroscope(negative)).toThrow(/nonnegative/);
    const fractional = structuredClone(source); fractional.flamebearer.numTicks = 100.5;
    expect(() => decodePyroscope(fractional)).toThrow(/integer/);
    const orphan = structuredClone(source); orphan.flamebearer.levels[2][0] = 120;
    expect(() => decodePyroscope(orphan)).toThrow(/containing parent/);
    const rate = structuredClone(source); rate.metadata.sampleRate = 0;
    expect(() => decodePyroscope(rate)).toThrow(/positive/);
  });

  it('requires inclusive cost to equal self plus immediate children', () => {
    const profile = accountingProfile();
    expect(profile.frames.reduce((sum, frame) => sum + frame.self, 0)).toBe(profile.total);
    expect(() => validateProfile(profile)).not.toThrow();
    const invalid = structuredClone(profile); invalid.frames[1].self++;
    expect(() => validateProfile(invalid)).toThrow(/Self \+ child costs/);
    const negative = structuredClone(profile); negative.frames[1].self = -1;
    expect(() => validateProfile(negative)).toThrow(/nonnegative/);
  });

  it('rejects duplicate IDs, wrong ancestry, overlapping siblings, and multiple roots', () => {
    const duplicate = accountingProfile(); duplicate.frames[4].id = 'a-leaf';
    expect(() => validateProfile(duplicate)).toThrow(/unique/);
    const parent = accountingProfile(); parent.frames[2].parentId = 'missing';
    expect(() => validateProfile(parent)).toThrow(/immediate parent/);
    const depth = accountingProfile(); depth.frames[2].depth = 1;
    expect(() => validateProfile(depth)).toThrow(/immediate parent/);
    const outside = accountingProfile(); outside.frames[2].start++;
    expect(() => validateProfile(outside)).toThrow(/immediate parent/);
    const overlap = accountingProfile(); overlap.frames[3].start--; overlap.frames[4].start--;
    expect(() => validateProfile(overlap)).toThrow(/overlap/);
    const roots = accountingProfile(); roots.frames[3].parentId = null;
    expect(() => validateProfile(roots)).toThrow(/one zero-offset root/);
  });

  it('preserves normalized record identities and rejects mixed unit or rate populations', () => {
    const source = accountingProfile(), records = profileToRecords(source);
    const decoded = profileFromRecords(records);
    expect(decoded.frames).toEqual(source.frames);
    expect(costs(decoded)).toEqual(costs(source));
    const unit = structuredClone(records); unit.rows[1][7] = 'bytes';
    expect(() => profileFromRecords(unit)).toThrow(/consistent/);
    const rate = structuredClone(records); rate.rows[1][8] = 200;
    expect(() => profileFromRecords(rate)).toThrow(/consistent/);
    const missing = structuredClone(records); missing.columns = missing.columns.filter(column => column.key !== 'parent');
    expect(() => profileFromRecords(missing)).toThrow(/Missing profile column/);
    const identity = structuredClone(records); identity.rows[1][0] = '';
    expect(() => profileFromRecords(identity)).toThrow(/characters/);
  });

  it('handles zero-cost profiles and rejects nonzero profiles with no root', () => {
    const empty = profileFromStacks([]);
    expect(empty.total).toBe(0);
    expect(decodePyroscope(encodeFlamebearer(empty)).frames).toEqual([]);
    expect(() => validateProfile({ ...empty, total: 1 })).toThrow(/root frame/);
    const falseEmpty = encodeFlamebearer(accountingProfile()); falseEmpty.flamebearer.numTicks = 0;
    expect(() => decodePyroscope(falseEmpty)).toThrow(/empty profile/);
  });

  it('does not double count recursive inclusive hotspots', () => {
    const profile = profileFromStacks([
      { stack: ['main', 'walk', 'walk', 'leaf'], value: 4 },
      { stack: ['main', 'walk'], value: 3 },
      { stack: ['other', 'walk'], value: 2 },
    ]);
    const hotspot = profileHotFunctions(profile).find(row => row.label === 'walk');
    expect(hotspot).toEqual({ label: 'walk', self: 5, total: 9, occurrences: 3 });
    expect(profile.frames.filter(frame => frame.label === 'walk').reduce((sum, frame) => sum + frame.total, 0)).toBe(13);
  });

  it('formats cost according to its declared unit and sample rate', () => {
    expect(formatProfileValue(100, { unit: 'samples', sampleRate: 200 })).toBe('500.00 ms');
    expect(formatProfileValue(3_000_000, { unit: 'nanoseconds', sampleRate: 1e9 })).toBe('3.00 ms');
    expect(formatProfileValue(1500, { unit: 'milliseconds', sampleRate: 1 })).toBe('1.500 s');
    expect(formatProfileValue(1_048_576, { unit: 'bytes', sampleRate: 100 })).toBe('1.00 MiB');
    expect(formatProfileValue(1234, { unit: 'objects', sampleRate: 100 })).toBe('1,234 objects');
  });
});

describe('time-ordered sampled profiles', () => {
  it.each([
    ['seconds', .001], ['milliseconds', 1], ['microseconds', 1000], ['nanoseconds', 1e6],
  ] as const)('normalizes %s weights to milliseconds while preserving empty sampled stacks', (unit, factor) => {
    const samples = decodeSpeedscope(simpleSpeedscope(unit, factor));
    expect(samples.map(({ start, end, stack }) => ({ start, end, stack }))).toEqual([
      { start: 2, end: 3, stack: ['main', 'work'] },
      { start: 3, end: 5, stack: [] },
    ]);
    expect(new Set(samples.map(sample => sample.id)).size).toBe(2);
  });

  it('rejects sample/weight mismatch, invalid extent, unknown frames, and non-time profiles', () => {
    const mismatch = simpleSpeedscope(); mismatch.profiles[0].weights.pop();
    expect(() => decodeSpeedscope(mismatch)).toThrow(/align/);
    const extent = simpleSpeedscope(); extent.profiles[0].endValue++;
    expect(() => decodeSpeedscope(extent)).toThrow(/reconcile/);
    const frame = simpleSpeedscope(); frame.profiles[0].samples[0] = [99];
    expect(() => decodeSpeedscope(frame)).toThrow(/Unknown Speedscope frame/);
    const weight = simpleSpeedscope(); weight.profiles[0].weights[0] = -1;
    expect(() => decodeSpeedscope(weight)).toThrow(/nonnegative/);
    expect(() => decodeSpeedscope(simpleSpeedscope('bytes'))).toThrow(/time unit/);
    expect(() => decodeSpeedscope(simpleSpeedscope('none'))).toThrow(/time unit/);
    const evented = simpleSpeedscope(); evented.profiles[0].type = 'evented';
    expect(() => decodeSpeedscope(evented)).toThrow(/Only sampled/);
  });

  it('keeps duplicate display names in distinct thread populations', () => {
    const doc = simpleSpeedscope();
    doc.profiles.push(structuredClone(doc.profiles[0]));
    doc.profiles.push({ ...structuredClone(doc.profiles[0]), name: 'worker [2]' });
    const samples = decodeSpeedscope(doc), threads = [...new Set(samples.map(sample => sample.thread))];
    expect(threads).toHaveLength(3);
    expect(threads[0]).toBe('worker');
    expect(threads[1]).toBe('worker [2]');
    expect(new Set(samples.map(sample => sample.id)).size).toBe(samples.length);
    expect(() => flamechartSpans(samples)).not.toThrow();
  });

  it('coalesces only contiguous equal ancestry and leaves sampling gaps empty', () => {
    const samples = temporalSamples(), original = structuredClone(samples);
    const spans = flamechartSpans([...samples].reverse());
    expect(spans.filter(span => span.label === 'main').map(span => [span.start, span.end])).toEqual([[0, 30], [40, 50]]);
    expect(spans.filter(span => span.label === 'write').map(span => [span.start, span.end])).toEqual([[10, 30], [40, 50]]);
    expect(spans.some(span => span.start < 40 && span.end > 30)).toBe(false);
    const lookup = new Map(spans.map(span => [span.id, span]));
    for (const span of spans) if (span.parentId) {
      const parent = lookup.get(span.parentId)!;
      expect(parent.depth).toBe(span.depth - 1);
      expect(parent.start).toBeLessThanOrEqual(span.start);
      expect(parent.end).toBeGreaterThanOrEqual(span.end);
    }
    expect(samples).toEqual(original);
  });

  it('does not merge matching leaf names when their ancestry changes', () => {
    const spans = flamechartSpans([
      { id: 'a', thread: 'worker', start: 0, end: 10, stack: ['left', 'leaf'] },
      { id: 'b', thread: 'worker', start: 10, end: 20, stack: ['right', 'leaf'] },
    ]);
    const leaves = spans.filter(span => span.label === 'leaf');
    expect(leaves).toHaveLength(2);
    expect(leaves[0].parentId).not.toBe(leaves[1].parentId);
    expect(leaves.map(span => [span.start, span.end])).toEqual([[0, 10], [10, 20]]);
  });

  it('rejects overlapping or duplicate samples while permitting concurrent threads', () => {
    const samples = temporalSamples(), overlap = structuredClone(samples); overlap[1].start = 9;
    expect(() => flamechartSpans(overlap)).toThrow(/overlap/);
    const duplicate = structuredClone(samples); duplicate[1].id = duplicate[0].id;
    expect(() => flamechartSpans(duplicate)).toThrow(/unique/);
    const empty = structuredClone(samples); empty[0].end = empty[0].start;
    expect(() => flamechartSpans(empty)).toThrow(/positive interval/);
    const concurrent = [...samples, { ...samples[0], id: 'other', thread: 'another worker' }];
    expect(() => flamechartSpans(concurrent)).not.toThrow();
  });

  it('roundtrips sampled records and rejects malformed serialized stacks', () => {
    const source = temporalSamples(), frame = samplesToRecords(source);
    expect(samplesFromRecords(frame)).toEqual(source);
    const malformed = structuredClone(frame); malformed.rows[0][4] = '{"not":"an array"}';
    expect(() => samplesFromRecords(malformed)).toThrow(/array/);
    const absent = structuredClone(frame); absent.columns = absent.columns.filter(column => column.key !== 'thread');
    expect(() => samplesFromRecords(absent)).toThrow(/Missing sample column/);
  });

  it('rejects gapped or overlapping sampled exports instead of collapsing the time axis', () => {
    expect(() => speedscopeFile(temporalSamples())).toThrow(/contiguous/);
    const overlap = temporalSamples().slice(0, 2); overlap[1].start--;
    expect(() => speedscopeFile(overlap)).toThrow(/contiguous/);
    const contiguous = temporalSamples().slice(0, 3);
    const exported = decodeSpeedscope(speedscopeFile(contiguous));
    expect(exported.map(({ id: _id, ...sample }) => sample)).toEqual(contiguous.map(({ id: _id, ...sample }) => sample));
  });
});

describe('profile imports and export fidelity', () => {
  it('detects formats and does not invent time samples for aggregate profiles', () => {
    const raw = parseProfileText(JSON.stringify(encodeFlamebearer(accountingProfile())));
    expect(raw.format).toBe('Pyroscope');
    expect(raw.samples).toBeNull();
    const folded = parseProfileText('main;work 5\nmain;read 3\n');
    expect(folded.format).toBe('Collapsed stacks');
    expect(folded.profile.total).toBe(8);
    expect(folded.samples).toBeNull();
    const sampled = parseProfileText(JSON.stringify(simpleSpeedscope()));
    expect(sampled.format).toBe('Speedscope sampled');
    expect(sampled.profile.unit).toBe('milliseconds');
    expect(sampled.profile.total).toBe(3);
    expect(sampled.profile.frames.find(frame => frame.parentId === null)?.self).toBe(2);
    expect(sampled.samples).toHaveLength(2);
  });

  it('requires explicit data and rejects malformed or excessive input', () => {
    expect(() => parseProfileText('   ')).toThrow(/Paste a profile/);
    expect(() => parseProfileText(' '.repeat(4_000_001))).toThrow(/4 MB/);
    expect(() => parseProfileText('{broken')).toThrow();
    expect(() => decodeCollapsed('a;b -2')).toThrow(/Invalid collapsed-stack/);
    expect(() => decodeCollapsed('a;;b 2')).toThrow(/characters/);
  });

  it('blocks folded exports that would lose units, sample rate, or unknown-stack self cost', () => {
    expect(() => collapsedProfile(profileFromStacks([{ stack: ['alloc'], value: 1024 }], 'alloc', 'bytes'))).toThrow(/retain other units/);
    expect(() => collapsedProfile(profileFromStacks([{ stack: ['cpu'], value: 10 }], 'cpu', 'samples', 200))).toThrow(/100 Hz/);
    expect(() => collapsedProfile(profileFromStacks([{ stack: [], value: 2 }, { stack: ['cpu'], value: 3 }]))).toThrow(/unknown stacks/);
    const source = profileFromStacks([{ stack: ['main', 'work'], value: 4 }, { stack: ['main'], value: 3 }]);
    expect(costs(decodeCollapsed(collapsedProfile(source)))).toEqual(costs(source));
  });

  it('rejects fractional Flamebearer cost export without rounding away work', () => {
    const fractional = profileFromStacks([{ stack: ['work'], value: .125 }], 'fractional time', 'milliseconds', 1000);
    expect(fractional.total).toBe(.125);
    expect(() => encodeFlamebearer(fractional)).toThrow(/integer costs/);
  });

  it.each(PROFILE_FIXTURES)('validates $id raw fixtures and keeps cost units intact', ({ id }) => {
    const fixture = buildProfileFixture(id), decoded = decodePyroscope(fixture.raw);
    expect(() => validateProfile(fixture.profile)).not.toThrow();
    expect(decoded.total).toBe(fixture.profile.total);
    expect(decoded.unit).toBe(fixture.profile.unit);
    expect(costs(decoded)).toEqual(costs(fixture.profile));
    expect(fixture.profile.frames.reduce((sum, frame) => sum + frame.self, 0)).toBe(fixture.profile.total);
    if (id === 'go-alloc') {
      expect(decoded.unit).toBe('bytes');
      expect(fixture.samples).toBeNull();
      expect(fixture.folded).toBeNull();
    } else {
      const samples = fixture.samples!;
      expect(samples).toHaveLength(360);
      expect(samples[0].start).toBe(0);
      expect(samples.at(-1)?.end).toBe(fixture.extent);
      samples.forEach((sample, index) => {
        if (index) expect(sample.start).toBe(samples[index - 1].end);
        expect((sample.end - sample.start) % 10).toBe(0);
      });
      const elapsedMs = samples.reduce((sum, sample) => sum + sample.end - sample.start, 0);
      expect(elapsedMs * fixture.profile.sampleRate / 1000).toBe(fixture.profile.total);
      expect(costs(decodeCollapsed(fixture.folded!))).toEqual(costs(fixture.profile));
      const sampled = parseProfileText(JSON.stringify(speedscopeFile(samples)));
      expect(sampled.profile.total).toBe(elapsedMs);
      expect(sampled.profile.unit).toBe('milliseconds');
    }
  });
});

describe('query-plan structural contracts', () => {
  it('preserves one root, ancestry depth, inclusive time, and supplied rows without summing times', () => {
    const nodes = parseQueryPlan(QUERY_PLAN), root = nodes.find(node => node.parent === null)!;
    expect(root).toMatchObject({ id: 'limit', depth: 0, actualMs: 96.8, rows: 100 });
    expect(nodes.find(node => node.id === 'customers')).toMatchObject({ depth: 4, actualMs: 9.6, rows: 4200, estimatedRows: 4000, loops: 1 });
    expect(nodes.reduce((sum, node) => sum + node.actualMs, 0)).toBeGreaterThan(root.actualMs);
    expect(parseQueryPlan({ ...QUERY_PLAN, rows: [] })).toEqual([]);
  });

  it('rejects missing/multiple roots, duplicate identities, orphan parents, and cycles', () => {
    const noRoot = structuredClone(QUERY_PLAN); noRoot.rows[0][1] = 'sort';
    expect(() => parseQueryPlan(noRoot)).toThrow(/one root/);
    const roots = structuredClone(QUERY_PLAN); roots.rows[1][1] = null;
    expect(() => parseQueryPlan(roots)).toThrow(/one root/);
    const duplicate = structuredClone(QUERY_PLAN); duplicate.rows[5][0] = 'scan';
    expect(() => parseQueryPlan(duplicate)).toThrow(/unique/);
    const orphan = structuredClone(QUERY_PLAN); orphan.rows[5][1] = 'not-present';
    expect(() => parseQueryPlan(orphan)).toThrow(/missing parent/);
    const cycle = structuredClone(QUERY_PLAN); cycle.rows[2][1] = 'hash';
    expect(() => parseQueryPlan(cycle)).toThrow(/cycle/);
  });

  it('rejects missing plan columns and invalid measured values', () => {
    const missing = structuredClone(QUERY_PLAN); missing.columns = missing.columns.filter(column => column.key !== 'actualMs');
    expect(() => parseQueryPlan(missing)).toThrow(/Missing query-plan column/);
    const negative = structuredClone(QUERY_PLAN); negative.rows[0][4] = -1;
    expect(() => parseQueryPlan(negative)).toThrow(/nonnegative/);
    const unknown = structuredClone(QUERY_PLAN); unknown.rows[0][4] = NaN;
    expect(() => parseQueryPlan(unknown)).toThrow(/finite/);
  });
});

describe('profiling registry, configuration, and embedded rendering', () => {
  registerProfilingCharts();

  it('registers idempotently and rejects unsupported configuration', () => {
    const first = getWidgetDefinition('plugin', 'profile-flamegraph');
    registerProfilingCharts();
    expect(getWidgetDefinition('plugin', 'profile-flamegraph')).toBe(first);
    expect(() => flamegraphConfig.parse({ invented: true })).toThrow();
    expect(() => flamegraphConfig.parse({ rowHeight: 5 })).toThrow();
    expect(() => flamechartConfig.parse({ rowHeight: 99 })).toThrow();
    expect(() => queryPlanConfig.parse({ showEstimates: 'yes' })).toThrow();
  });

  for (const feature of profilingChartCatalog) {
    it(`${feature.id} normalizes every advertised preset and renders embedded without active controls`, () => {
      for (const preset of feature.presets) {
        const fixture = makeProfilingCatalogFixture(feature.id, preset);
        expect(() => widgetSchema.parse(fixture.widget)).not.toThrow();
        const definition = getWidgetDefinition('plugin', fixture.widget.pluginId!);
        expect(definition).toBeDefined();
        expect(() => definition!.parseConfig!(fixture.widget.config)).not.toThrow();
        const markup = renderToStaticMarkup(createElement(definition!.render, { ...fixture, embedded: true }));
        expect(markup).not.toMatch(/NaN|Infinity/);
        expect(markup).not.toContain('role="button"');
        expect(markup).not.toContain('tabindex="0"');
        expect(markup).not.toMatch(/<(?:input|select|form)\b/);
        for (const button of markup.matchAll(/<button\b([^>]*)>/g)) expect(button[1]).toMatch(/\bdisabled(?:=|\s|$)/);
        if (preset === 'empty') {
          expect(fixture.result.records?.rows).toHaveLength(0);
          expect(markup).not.toContain('<svg');
        } else {
          expect(markup).toContain('<svg');
        }
      }
    });
  }
});
