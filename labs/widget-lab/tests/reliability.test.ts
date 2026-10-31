import { describe, expect, it } from 'vitest';
import { ALLOWED_ERROR_RATIO, HOUR_MS, RELIABILITY_SERVICES, buildReliability, incidentCalendar, reliabilityBurnSeries, reliabilityIncidents, reliabilityTimeline, summarizeReliability, type ReliabilityIncident } from '../src/data/reliability';

describe('request-based reliability fixtures', () => {
  it('is deterministic and supplies full six-hour lookback', () => {
    const data = buildReliability(30, 'incident');
    expect(buildReliability(30, 'incident')).toEqual(data);
    expect(data.points).toHaveLength((30 * 24 + 5) * 4);
    const burn = reliabilityBurnSeries(data);
    expect(burn).toHaveLength(720);
    expect(burn[0].sixHour).not.toBeNull();
    expect(burn.at(-1)?.timestampMs).toBe(data.endMs);
  });

  it('weights fleet availability by request counts and conserves budgets', () => {
    const data = buildReliability();
    const all = summarizeReliability(data);
    const perService = RELIABILITY_SERVICES.map(service => summarizeReliability(data, service.id));
    expect(all.requests).toBe(perService.reduce((sum, item) => sum + item.requests, 0));
    expect(all.failures).toBe(perService.reduce((sum, item) => sum + item.failures, 0));
    expect(all.availability).toBeCloseTo(1 - all.failures / all.requests, 12);
    expect(all.allowedFailures).toBeCloseTo(all.requests * ALLOWED_ERROR_RATIO, 8);
    expect((all.budgetRemaining ?? 0) * all.allowedFailures + all.failures).toBeCloseTo(all.allowedFailures, 8);
  });

  it('calculates six-hour burn from pooled counts rather than mean hourly ratios', () => {
    const data = buildReliability(1, 'incident');
    const last = reliabilityBurnSeries(data, 'payment-api').at(-1)!;
    const window = summarizeReliability(data, 'payment-api', data.endMs - 6 * HOUR_MS, data.endMs);
    expect(last.sixHour).toBeCloseTo((window.errorRatio ?? 0) / ALLOWED_ERROR_RATIO, 10);
    expect(last.oneHour).toBeGreaterThan(1);
  });

  it('retains missing observations and invalidates incomplete rolling windows', () => {
    const data = buildReliability(7, 'gaps');
    const summary = summarizeReliability(data);
    const last = reliabilityBurnSeries(data).at(-1)!;
    expect(summary.coverage).toBeLessThan(1);
    expect(last.requests).toBeNull();
    expect(last.oneHour).toBeNull();
    expect(last.sixHour).toBeNull();
    expect(reliabilityTimeline(data, 'payment-api').at(-1)?.state).toBe('missing');
    expect(reliabilityTimeline(data, 'catalog-api').at(-1)?.state).toBe('healthy');
  });

  it('preserves time duration and exact selected-window counts across timeline bins', () => {
    for (const days of [1, 7, 30] as const) {
      const data = buildReliability(days);
      const cells = reliabilityTimeline(data, 'payment-api');
      expect(cells[0].startMs).toBe(data.startMs);
      expect(cells.at(-1)?.endMs).toBe(data.endMs);
      expect(cells.reduce((total, cell) => total + cell.endMs - cell.startMs, 0)).toBe(days * 24 * HOUR_MS);
      expect(cells.reduce((total, cell) => total + cell.requests, 0)).toBe(summarizeReliability(data, 'payment-api').requests);
    }
  });

  it('filters incidents to service and window and advances snapshot time', () => {
    const data = buildReliability(1, 'incident');
    expect(reliabilityIncidents(data)).toHaveLength(1);
    expect(reliabilityIncidents(data, 'catalog-api')).toHaveLength(0);
    expect(reliabilityIncidents(buildReliability(30, 'steady'))).toHaveLength(0);
    expect(buildReliability(1, 'incident', 1).endMs - data.endMs).toBe(HOUR_MS);
  });

  it.each(['steady', 'incident', 'gaps'] as const)('preserves every overlapping observation when advancing the %s snapshot', scenario => {
    const previous = buildReliability(30, scenario, 0);
    const next = buildReliability(30, scenario, 1);
    const overlapStart = next.points[0].timestampMs;
    expect(next.points.filter(point => point.timestampMs <= previous.endMs))
      .toEqual(previous.points.filter(point => point.timestampMs >= overlapStart));
    expect(next.points.filter(point => point.timestampMs > previous.endMs)).toHaveLength(RELIABILITY_SERVICES.length);
    const nextLatest = reliabilityBurnSeries(next, 'payment-api').at(-1)!;
    expect(nextLatest.requests).not.toBeNull();
    if (scenario !== 'steady') expect(nextLatest.oneHour).toBeGreaterThan(1);
    if (scenario === 'gaps') expect(nextLatest.sixHour).toBeNull();
  });

  it('keeps resolved incident times fixed and extends only the active incident end', () => {
    const previous = reliabilityIncidents(buildReliability(30, 'incident', 0));
    const next = reliabilityIncidents(buildReliability(30, 'incident', 1));
    const resolved = previous.filter(event => event.status === 'Resolved');
    expect(resolved).toHaveLength(3);
    expect(next.filter(event => event.status === 'Resolved')).toEqual(resolved);
    const activeBefore = previous.find(event => event.status === 'Active')!;
    const activeAfter = next.find(event => event.status === 'Active')!;
    expect(activeAfter).toEqual({ ...activeBefore, endMs: activeBefore.endMs + HOUR_MS });
  });

  it('retains negative remaining budget when a service exceeds its allowance', () => {
    const summary = summarizeReliability(buildReliability(1, 'incident'), 'payment-api');
    expect(summary.failures).toBeGreaterThan(summary.allowedFailures);
    expect(summary.budgetRemaining).toBeLessThan(0);
  });
});

describe('incident calendar partitioning', () => {
  it('uses actual scoped episodes and distinguishes empty dates from outside-window dates', () => {
    const data = buildReliability(30, 'incident');
    const calendar = incidentCalendar({ ...data, incidents: reliabilityIncidents(data), timeZone: 'UTC' });
    expect(calendar.availableMonths).toEqual(['2026-09', '2026-10']);
    expect(calendar.days).toHaveLength(35);
    expect(calendar.days[0].key).toBe('2026-09-28');
    expect(calendar.days.find(day => day.key === '2026-09-30')?.state).toBe('none');
    expect(calendar.days.find(day => day.key === '2026-10-29')).toMatchObject({ state: 'active', activeCount: 1, resolvedCount: 0, episodeIds: ['payment-api-3'] });
    expect(calendar.days.find(day => day.key === '2026-10-26')).toMatchObject({ state: 'resolved', activeCount: 0, resolvedCount: 1, episodeIds: ['auth-api-90'] });
    expect(calendar.days.find(day => day.key === '2026-10-30')).toMatchObject({ state: 'outside', inWindow: false, episodeIds: [] });
    const catalogue = incidentCalendar({ ...data, incidents: reliabilityIncidents(data, 'catalog-api'), timeZone: 'UTC' });
    expect(catalogue.days.filter(day => day.inWindow).every(day => day.state === 'none')).toBe(true);
  });

  it('clips episodes to the chosen window without changing their identities', () => {
    const data = buildReliability(1, 'incident');
    const episodes = reliabilityIncidents(buildReliability(30, 'incident'));
    const calendar = incidentCalendar({ ...data, incidents: episodes, timeZone: 'UTC' });
    expect(calendar.days.filter(day => day.inWindow).map(day => day.key)).toEqual(['2026-10-29']);
    expect(calendar.days.flatMap(day => day.episodeIds)).toEqual(['payment-api-3']);
    expect(episodes).toHaveLength(4);
  });

  it('treats episode endpoints as exclusive and converts dates in the chosen timezone', () => {
    const incident: ReliabilityIncident = { id: 'midnight', serviceId: 'payment-api', title: 'Fixture episode', status: 'Resolved',
      startMs: Date.UTC(2026, 9, 25, 23), endMs: Date.UTC(2026, 9, 26) };
    const input = { startMs: Date.UTC(2026, 9, 25), endMs: Date.UTC(2026, 9, 27), incidents: [incident] };
    const utc = incidentCalendar({ ...input, timeZone: 'UTC' });
    const tokyo = incidentCalendar({ ...input, timeZone: 'Asia/Tokyo' });
    expect(utc.days.filter(day => day.episodeIds.length).map(day => day.key)).toEqual(['2026-10-25']);
    expect(tokyo.days.filter(day => day.episodeIds.length).map(day => day.key)).toEqual(['2026-10-26']);
  });

  it.each([
    { name: 'spring-forward', windowStart: '2026-03-07T05:00:00Z', windowEnd: '2026-03-10T04:00:00Z', start: '2026-03-08T04:30:00Z', end: '2026-03-09T04:30:00Z', dates: ['2026-03-07', '2026-03-08', '2026-03-09'] },
    { name: 'fall-back', windowStart: '2026-10-31T04:00:00Z', windowEnd: '2026-11-03T05:00:00Z', start: '2026-11-01T03:30:00Z', end: '2026-11-02T05:30:00Z', dates: ['2026-10-31', '2026-11-01', '2026-11-02'] },
  ])('partitions $name local dates without assuming 24-hour days', fixture => {
    const incident: ReliabilityIncident = { id: 'dst', serviceId: 'auth-api', title: 'Fixture episode', status: 'Resolved', startMs: Date.parse(fixture.start), endMs: Date.parse(fixture.end) };
    const calendar = incidentCalendar({ startMs: Date.parse(fixture.windowStart), endMs: Date.parse(fixture.windowEnd), incidents: [incident], timeZone: 'America/New_York' });
    expect(calendar.days.filter(day => day.inWindow).map(day => day.key)).toEqual(fixture.dates);
    expect(calendar.days.filter(day => day.episodeIds.length).map(day => day.key)).toEqual(fixture.dates);
  });

  it('keeps earlier months reachable and rejects stale month selections after a window change', () => {
    const data = buildReliability(30, 'steady');
    const previous = incidentCalendar({ ...data, incidents: [], timeZone: 'UTC', month: '2026-09' });
    expect(previous.month).toBe('2026-09');
    expect(previous.days.find(day => day.key === '2026-09-30')).toMatchObject({ inMonth: true, inWindow: true, state: 'none' });
    const shorter = incidentCalendar({ ...buildReliability(1, 'steady'), incidents: [], timeZone: 'UTC', month: '2026-09' });
    expect(shorter.month).toBe('2026-10');
    expect(shorter.availableMonths).toEqual(['2026-10']);
  });
});
