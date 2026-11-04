// @vitest-environment happy-dom
//
// Smoke test for the lab's grid host. It mounts production's DashboardCanvas (`@insights/canvas`) under happy-dom with
// react-grid-layout replaced by tests/support/rgl-mock.ts. It proves that the @insights alias, the react-grid-layout and
// react-resizable dependencies and the canvas's import closure all resolve from the lab, and that a dashboard renders
// its tiles with data. It changes no app code.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardCanvas } from '@insights/canvas';
import { dashboardSchema, type Provider, type QueryRequest, type QueryResult } from '@insights/schema';
import { resetRglMock, rglMock, WIDE_CANVAS_WIDTH } from './support/rgl-mock';

vi.mock('react-grid-layout', () => import('./support/rgl-mock'));

// React runs state updates through act only when the environment says it is a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no IntersectionObserver. Without one, a tile starts hidden and never queries, so this stub reports every
// observed tile as intersecting as soon as it is observed. That matches a tile that is in the viewport. It does not
// model scrolling, and the lab's own visibility checks do that in a browser.
class ReportsEverythingVisible {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    const entry = { target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// The fixture window. The dashboard's customTimeRange fixes the canvas window, so every request must ask for exactly it.
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const PROVIDER_ID = 'lab-smoke-prometheus';
const STAT_QUERY = 'sum(rate(lab_smoke_requests_total[5m]))';
const SERIES_QUERY = 'histogram_quantile(0.95, sum by (le) (rate(lab_smoke_latency_seconds_bucket[5m])))';

// dashboardSchema is production's strict schema, so a lab-only key or a bad layout fails here, at import.
const dashboard = dashboardSchema.parse({
  schemaVersion: 1,
  id: 'lab-canvas-smoke',
  title: 'Lab canvas smoke',
  timeRange: '1h',
  refreshInterval: 0,
  customTimeRange: { from: FROM, to: TO },
  widgets: [
    {
      id: 'requests',
      title: 'Request rate',
      type: 'stat',
      providerId: PROVIDER_ID,
      query: STAT_QUERY,
      unit: 'req/s',
      layout: { x: 0, y: 0, w: 4, h: 2 },
    },
    {
      id: 'latency',
      title: 'P95 latency',
      type: 'timeseries',
      providerId: PROVIDER_ID,
      query: SERIES_QUERY,
      unit: 's',
      layout: { x: 4, y: 0, w: 8, h: 4 },
    },
  ],
});

const providers: Provider[] = [
  { id: PROVIDER_ID, name: 'Prometheus · lab smoke', type: 'prometheus', capabilities: ['metrics'] },
];

// Fixture results, keyed by the request's query string. Every point sits inside the fixed window, in milliseconds.
const fixtures = new Map<string, QueryResult>([
  [STAT_QUERY, { series: [{ name: 'requests', labels: {}, points: [{ timestamp: toMs - 60_000, value: 42 }] }] }],
  [
    SERIES_QUERY,
    {
      series: [
        {
          name: 'p95',
          labels: {},
          points: Array.from({ length: 60 }, (_, minute) => ({
            timestamp: fromMs + minute * 60_000,
            value: 0.12 + (minute % 7) / 100,
          })),
        },
      ],
    },
  ],
]);

let requests: QueryRequest[] = [];
let pending = 0;

// The canvas calls the fetcher with the request and an abort signal. Unknown queries fail loudly.
async function fetcher(request: QueryRequest, signal: AbortSignal): Promise<QueryResult> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  requests.push(request);
  pending += 1;
  try {
    const result = fixtures.get(request.query);
    if (!result) throw new Error(`no fixture for query: ${request.query}`);
    return result;
  } finally {
    pending -= 1;
  }
}

let container: HTMLDivElement;
let root: Root;

function canvas(editing: boolean) {
  return (
    <DashboardCanvas
      dashboard={dashboard}
      providers={providers}
      fetcher={fetcher}
      end={toMs / 1000}
      editing={editing}
      onSelect={() => {}}
      onLayout={() => {}}
    />
  );
}

const tiles = () => [...container.querySelectorAll<HTMLElement>('article[data-widget-id]')];
const tile = (id: string) => container.querySelector<HTMLElement>(`article[data-widget-id="${id}"]`);
const showsPlaceholder = () => /Waiting to load|Querying data source/.test(container.textContent ?? '');

// Runs pending timers and fetches inside act, until both widgets have their results and nothing is in flight.
async function settle() {
  for (let attempt = 0; attempt < 200; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    if (new Set(requests.map((request) => request.query)).size === 2 && pending === 0 && !showsPlaceholder()) return;
  }
  throw new Error('timed out waiting for both widgets to finish their first load');
}

async function renderSettled(editing: boolean) {
  act(() => root.render(canvas(editing)));
  await settle();
}

describe('lab grid host: production DashboardCanvas under happy-dom', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ReportsEverythingVisible);
    resetRglMock(WIDE_CANVAS_WIDTH);
    requests = [];
    pending = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('runs under happy-dom, with the canvas in its wide, editable mode at 1440 px', async () => {
    expect(navigator.userAgent).toMatch(/happy-?dom/i);
    await renderSettled(false);
    expect(container.querySelector('[data-testid="dashboard-canvas"]')?.getAttribute('data-layout-mode')).toBe('wide');
    expect(rglMock.renders.length).toBeGreaterThan(0);
  });

  it('renders two tiles, and neither shows a placeholder or an error after its fetch resolves', async () => {
    await renderSettled(false);

    expect(tiles().map((el) => el.dataset.widgetId).sort()).toEqual(['latency', 'requests']);
    for (const el of tiles()) {
      const id = el.dataset.widgetId;
      expect(el.textContent ?? '', id).not.toMatch(/not configured|Waiting to load|Querying data source|is not available/i);
      expect(el.querySelector('[role="alert"]'), id).toBeNull();
    }
    expect(tile('requests')?.textContent ?? '').toContain('42');

    // Every query asked for the dashboard's fixed window, in seconds.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.start, request.query).toBe(fromMs / 1000);
      expect(request.end, request.query).toBe(toMs / 1000);
    }
  });

  it('turns drag and resize on in the grid when the canvas is editing', async () => {
    await renderSettled(false);
    expect(rglMock.props?.dragConfig?.enabled).toBe(false);

    await renderSettled(true);
    expect(rglMock.props?.dragConfig?.enabled).toBe(true);
    expect(rglMock.props?.resizeConfig?.enabled).toBe(true);
  });
});
