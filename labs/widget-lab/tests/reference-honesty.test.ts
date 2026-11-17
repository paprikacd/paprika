import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReferenceEdge } from '../src/reference/ReferenceEdge';
import { BudgetMetric, ReferenceReliability, referenceConsumedShare, SERVICES, ServicesTable } from '../src/reference/ReferenceReliability';

const edgeHtml = renderToStaticMarkup(createElement(ReferenceEdge, { onTools: () => undefined, onSearch: () => undefined }));
const reliabilityHtml = renderToStaticMarkup(createElement(ReferenceReliability));

/** Width percentage of the budget bar fill, as rendered. */
const barFill = (html: string) => Number(html.match(/ref-rel-budget-track"><span style="width:([\d.]+)%/)?.[1]);

describe('reference studies do not present fixture values as live state', () => {
  it('never labels a paused fixture as Live', () => {
    for (const html of [edgeHtml, reliabilityHtml]) expect(html).not.toMatch(/\bLive\b/);
    expect(edgeHtml).toContain('Demo data');
    expect(reliabilityHtml).toContain('Fixture replay');
    expect(edgeHtml).toContain('ref-replay-neutral');
    expect(reliabilityHtml).toContain('ref-replay-neutral');
  });

  it('shows no invented KPI deltas or comparison windows', () => {
    expect(edgeHtml).not.toContain('ref-edge-metric-change');
    expect(reliabilityHtml).not.toContain('ref-rel-metric-delta');
    for (const html of [edgeHtml, reliabilityHtml]) expect(html).not.toContain('vs. previous');
  });

  it('offers only the single traced gateway profile, disabled with an explanation', () => {
    expect(edgeHtml).not.toContain('edge-02');
    expect(edgeHtml).toMatch(/<select aria-label="Gateway"[^>]*disabled=""[^>]*title="Single traced profile/);
  });

  it('sizes every budget bar from the consumed share it states', () => {
    for (const service of SERVICES) {
      const card = renderToStaticMarkup(createElement(BudgetMetric, { service }));
      const consumed = Number(card.match(/(\d+\.\d{2})m consumed/)?.[1]);
      const allowed = Number(card.match(/\/ (\d+\.\d{2})m allowed/)?.[1]);
      expect(barFill(card), service.name).toBeCloseTo(Math.min(100, consumed / allowed * 100), 2);
      expect(barFill(card), service.name).toBe(referenceConsumedShare(service.availability));
    }
    const uptime = SERVICES.find(service => service.name === 'uptime-api')!;
    expect(barFill(renderToStaticMarkup(createElement(BudgetMetric, { service: uptime })))).toBe(40);
  });

  it('derives the budget card and the service table row from one value for every service', () => {
    const rows = renderToStaticMarkup(createElement(ServicesTable, { onSelect: () => undefined })).split('<tr>');
    for (const service of SERVICES) {
      const card = renderToStaticMarkup(createElement(BudgetMetric, { service }));
      const remaining = card.match(/ref-rel-metric-value[^>]*>(-?[\d.]+) <span>%<\/span>/)?.[1];
      const consumed = card.match(/(\d+\.\d{2})m consumed/)?.[1];
      const row = rows.find(chunk => chunk.includes(`>${service.name}</button>`)) ?? '';
      expect(remaining, service.name).toBeDefined();
      expect(row, service.name).toContain(`${remaining}%`);
      expect(row, service.name).toContain(`${consumed}m / 43.20m`);
    }
    const payment = renderToStaticMarkup(createElement(BudgetMetric, { service: SERVICES.find(service => service.name === 'payment-api')! }));
    expect(payment).toContain('-180.00 <span>%</span>');
    expect(barFill(payment)).toBe(100);
  });
});
