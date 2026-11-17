import { installRichChartFixtureAPI } from './rich-chart-api.mjs';

// Revision 1: a dense, deterministic sample through the real dashboard host.
// No provider credentials or production observations are used.
export async function installChartSystemFixture(page, base) {
  const fixture = await installRichChartFixtureAPI(page, base);
  const dashboard = fixture.documents.get('example-artboard-edge-watch');
  const records = {
    columns: [
      { key: 'label', label: 'Location', type: 'string' },
      { key: 'latitude', label: 'Latitude', type: 'number' },
      { key: 'longitude', label: 'Longitude', type: 'number' },
      { key: 'value', label: 'Requests', type: 'number', unit: 'requests' },
      { key: 'status', label: 'Status', type: 'string' },
    ],
    rows: Array.from({ length: 500 }, (_, index) => [`Location ${String(index + 1).padStart(3, '0')}`, -60 + index % 17 * 7, -160 + index * 29 % 320, index === 1 ? null : index * 17 % 997, index % 7 ? 'Allowed' : 'Blocked']),
  };
  const common = { type: 'plugin', dataKind: 'records', providerId: 'example-records', query: '{"fixture":"chart-system-records"}', unit: 'requests', options: { decimals: 0 } };
  const mapConfig = { latitude: 'latitude', longitude: 'longitude', label: 'label', value: 'value' };
  dashboard.title = 'Chart system regression';
  dashboard.description = 'Deterministic fixture · 500 records, including zero and missing values';
  dashboard.refreshInterval = 0;
  dashboard.widgets = [
    { ...common, id: 'hex-map', title: 'Requests by location', pluginId: 'geo-heatmap', config: { ...mapConfig, mode: 'map', aggregation: 'sum', maxRecords: 500 }, layout: { x: 0, y: 0, w: 6, h: 5 } },
    { ...common, id: 'honeycomb', title: 'Individual observations', pluginId: 'geo-heatmap', config: { ...mapConfig, mode: 'grid', aggregation: 'mean', maxRecords: 500 }, layout: { x: 6, y: 0, w: 6, h: 5 } },
    { ...common, id: 'records', title: 'Recorded requests', pluginId: 'record-table', config: { columns: ['label', 'value', 'status'], density: 'compact', pageSize: 5, showSearch: true, cellStyles: [{ column: 'value', display: 'bar', min: 0, max: 1000 }, { column: 'status', display: 'status-badge' }] }, layout: { x: 0, y: 5, w: 6, h: 4 } },
    { ...common, id: 'markers', title: 'Observed connections', pluginId: 'connection-map', config: { ...mapConfig, display: 'density', status: 'status', maxPoints: 500, showLocations: false }, layout: { x: 6, y: 5, w: 6, h: 5 } },
  ];
  await page.route(`${new URL(base).origin}/api/insights/query`, async route => {
    if (route.request().postDataJSON().query !== common.query) return route.fallback();
    fixture.calls.push({ method: 'POST', path: '/query', document: { query: common.query } });
    await route.fulfill({ json: { records } });
  });
  return { ...fixture, dashboard, records };
}
