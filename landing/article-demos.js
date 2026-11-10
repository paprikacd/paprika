// Static, deterministic fixtures for interactive public engineering examples.
// They intentionally never query, store, or impersonate production telemetry.
const examples = {
  release: {
    title: 'Release evidence workbench',
    intro: 'Select a deployment target. Compare readiness, drift and the evidence behind the status.',
    source: 'Kubernetes / illustrative release',
    choices: [
      { key: 'dev', label: 'Development', state: 'Synced, workloads ready',
        value: '3 / 3', unit: 'workloads ready', status: 'Observed', tone: 'good',
        signal: 'Reconciliation observations', series: [28, 32, 29, 34, 36, 36, 38, 39, 41, 42, 43, 43], suffix: 'events',
        query: 'max by (app, namespace) (paprika_out_of_sync)',
        note: 'The example reports no drift for this selected target. Workload readiness remains a separate observation.' },
      { key: 'staging', label: 'Staging', state: 'Revision selected, readiness pending',
        value: '2 / 3', unit: 'workloads ready', status: 'Investigate', tone: 'warn',
        signal: 'Reconciliation observations', series: [25, 28, 30, 27, 19, 17, 22, 23, 25, 29, 24, 21], suffix: 'events',
        query: 'max by (application, namespace) (paprika_application_reconcile_lag)',
        note: 'A selected revision does not prove convergence. Inspect the Application, resource conditions and query freshness.' },
      { key: 'production', label: 'Production', state: 'Candidate held, signal unavailable',
        value: 'No data', unit: 'service signal', status: 'Unverified', tone: 'warn',
        signal: 'Service telemetry unavailable', series: [], suffix: 'events',
        query: 'sum by (app) (rate(paprika_sync_errors_total[5m]))',
        note: 'Missing provider samples are not a healthy zero. Production retains its last accepted Release while the candidate awaits approval.' },
    ],
  },
  prometheus: {
    title: 'Prometheus query semantics',
    intro: 'Switch metric types to see why the chart and PromQL must follow the underlying data.',
    source: 'Metrics / illustrative series',
    choices: [
      { key: 'counter', label: 'Counter', state: 'Use a rate for recent errors',
        value: '0.08', unit: 'errors/s', status: 'Rate', tone: 'neutral',
        signal: 'Estimated errors per second', series: [2, 3, 3, 4, 4, 8, 7, 6, 5, 3, 2, 2], suffix: '× 0.01 errors/s',
        query: 'sum by (app) (rate(paprika_sync_errors_total[5m]))',
        note: 'A raw counter grows across the process lifetime. Rate handles resets using the available scrape samples.' },
      { key: 'gauge', label: 'Gauge', state: 'Current observed drift',
        value: '2', unit: 'out-of-sync resources', status: 'Snapshot', tone: 'neutral',
        signal: 'Out-of-sync resource count', series: [0, 0, 1, 1, 1, 2, 2, 3, 2, 2, 1, 2], suffix: 'resources',
        query: 'max by (app, namespace) (paprika_out_of_sync)',
        note: 'A gauge may move up or down. It describes a current condition, not the number of incidents in the period.' },
      { key: 'histogram', label: 'Histogram', state: 'Bucket-based duration distribution',
        value: '0.48', unit: 's · illustrative p95', status: 'Quantile', tone: 'neutral',
        signal: 'Illustrative bucket observations', series: [3, 8, 17, 22, 18, 12, 7, 4, 2, 1, 0, 0], chart: 'bars', suffix: 'observations',
        query: 'histogram_quantile(0.95, sum by (le, app) (rate(paprika_sync_duration_seconds_bucket[10m])))',
        note: 'Aggregate histogram buckets with le preserved before calculating the quantile. Do not average independent p95 values.' },
    ],
  },
  layout: {
    title: 'Dashboard design studio',
    intro: 'Compare an overview with a diagnostic view. Toggle the theme and inspect the synthetic series.',
    source: 'Insights / illustrative layout',
    choices: [
      { key: 'overview', label: 'Overview', state: 'Decision first',
        value: '99.2', unit: '% availability · example', status: 'Overview', tone: 'good',
        signal: 'Availability trend', series: [97.1, 97.9, 98.2, 98.5, 98.1, 99.1, 98.9, 99.2, 99.2, 99.1, 99.2, 99.2], suffix: '%',
        query: 'Select a service and an explicit window before comparing panels.',
        note: 'One high-priority KPI plus a readable trend gives the operator a question to investigate.' },
      { key: 'diagnose', label: 'Diagnose', state: 'Move from symptom to evidence',
        value: '3', unit: 'exception groups · example', status: 'Explore', tone: 'warn',
        signal: 'Error groups per interval', series: [1, 1, 2, 2, 3, 5, 4, 3, 3, 2, 3, 3], suffix: 'groups',
        query: 'Expose the provider, affected series and link to logs or traces.',
        note: 'Breakdowns belong next to the anomaly; tooltips and legends must not obscure the point under inspection.' },
      { key: 'empty', label: 'No samples', state: 'Explicit missing-data state',
        value: 'No data', unit: 'provider not returning series', status: 'Unknown', tone: 'warn',
        signal: 'No observations for selected filters', series: [], suffix: '',
        query: 'Do not coerce an empty result to numeric zero.',
        note: 'A missing series is not an availability of 0%. Keep the selected provider and query state visible.' },
    ],
  },
  testing: {
    title: 'Visual acceptance lab',
    intro: 'Exercise desktop/mobile layout and missing-data states. This is a local synthetic preview, not the private screenshot worker.',
    source: 'Browser verification / illustrative',
    choices: [
      { key: 'desktop', label: 'Desktop', state: 'Wide layout, visible inspection',
        value: '4', unit: 'evidence panels', status: 'Layout', tone: 'neutral',
        signal: 'Example response-time trend', series: [82, 75, 74, 88, 84, 80, 79, 92, 81, 83, 78, 77], suffix: 'ms',
        query: 'Verify page width, full legend labels and bounded tooltips.',
        note: 'A screenshot is only useful when it matches the saved dashboard revision and includes the tested viewport.' },
      { key: 'mobile', label: 'Mobile', state: 'Narrow, deliberately reordered',
        value: '390', unit: 'CSS px viewport', status: 'Reflow', tone: 'neutral',
        signal: 'Example response-time trend', series: [82, 75, 74, 88, 84, 80, 79, 92, 81, 83, 78, 77], suffix: 'ms',
        query: 'Inspect card order, touch targets, legends and overflow.',
        note: 'A mobile dashboard should preserve the current incident signal before lower-priority distributions.' },
      { key: 'unavailable', label: 'Provider error', state: 'Failure shown explicitly',
        value: 'Unavailable', unit: 'provider query failed', status: 'Query error', tone: 'warn',
        signal: 'No trusted values to plot', series: [], suffix: '',
        query: 'Record the provider error, not a synthetic baseline.',
        note: 'A failed provider query must not silently become a green KPI or a zero-value time series.' },
    ],
  },
  mcp: {
    title: 'MCP dashboard authoring loop',
    intro: 'Inspect the evidence required at each stage. Saving a document is not the end of validation.',
    source: 'Observe MCP / illustrative lifecycle',
    choices: [
      { key: 'discover', label: 'Discover', state: 'Provider IDs and signal metadata',
        value: '3', unit: 'fixture providers', status: 'Inspect', tone: 'neutral',
        signal: 'Discovery response sample', series: [1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3], suffix: 'sources',
        query: 'list_observability_providers → list_insights_providers → get_insights_schema',
        note: 'Do not invent metric names or convert a namespace/name reference into an Insights ID.' },
      { key: 'query', label: 'Query', state: 'Execute actual bound saved queries',
        value: '12', unit: 'fixture points', status: 'Inspect', tone: 'neutral',
        signal: 'Bound query observations', series: [6, 8, 7, 10, 9, 10, 11, 9, 12, 12, 11, 12], suffix: 'points',
        query: 'query_dashboard { variables: { service: "checkout" }, history_points: 12 }',
        note: 'Use the structured signal states, timestamps and errors. An OK data state is not itself a service health verdict.' },
      { key: 'verify', label: 'Verify', state: 'Read back document and inspect UI',
        value: 'ETag', unit: 'exact revision', status: 'Compare', tone: 'good',
        signal: 'Illustrative data comparison', series: [6, 8, 7, 10, 9, 10, 11, 9, 12, 12, 11, 12], suffix: 'points',
        query: 'get_dashboard → query_dashboard → render_dashboard (when enabled)',
        note: 'The optional renderer verifies a real UI revision, not the mere existence of a valid JSON document.' },
    ],
  },
};

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);

export const demoKeys = Object.freeze(Object.keys(examples));
export const galleryRoutes = Object.freeze(['charts', 'kubernetes-fleet', 'performance-workbench', 'distributed-systems']);

function pathFor(series) {
  if (!series.length) return '';
  const high = Math.max(...series);
  const low = Math.min(...series);
  const spread = Math.max(1, high - low);
  return series.map((value, index) => {
    const x = 26 + index * (498 / Math.max(1, series.length - 1));
    const y = 162 - (value - low) / spread * 117;
    return (index ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
}

function barsFor(series) {
  if (!series.length) return '';
  const high = Math.max(1, ...series);
  return series.map((value, index) => {
    const height = Math.max(0, value / high * 119);
    const x = 28 + index * 40;
    return `<rect x="${x}" y="${162 - height}" width="26" height="${height}" rx="1" class="demo-bar"/>`;
  }).join('');
}

export function renderDashboardDemo(key, prefix = '../../') {
  const example = examples[key];
  if (!example) throw new Error('Unknown editorial demo: ' + key);
  const first = example.choices[0];
  const buttons = example.choices.map((choice, i) =>
    `<button type="button" data-demo-choice="${escapeHTML(choice.key)}" aria-pressed="${i === 0}" class="demo-choice">${escapeHTML(choice.label)}</button>`).join('');
  return `<section class="editorial-demo" data-editorial-demo="${escapeHTML(key)}" data-demo-theme="dark" aria-label="${escapeHTML(example.title)}">
  <div class="demo-heading">
    <div><span class="demo-kicker"><span class="demo-live-dot" aria-hidden="true"></span> INTERACTIVE / SYNTHETIC DATA</span>
      <h3>${escapeHTML(example.title)}</h3><p>${escapeHTML(example.intro)}</p></div>
    <button type="button" data-demo-theme-toggle aria-pressed="false" class="demo-theme">Light theme</button>
  </div>
  <div class="demo-toolbar"><span class="demo-source">${escapeHTML(example.source)}</span><div class="demo-choices" role="group" aria-label="Example view">${buttons}</div></div>
  <div class="demo-interface">
    <div class="demo-metrics">
      <div class="demo-kpi"><span class="demo-label">Selected measurement</span><strong data-demo-value>${escapeHTML(first.value)}</strong><span data-demo-unit>${escapeHTML(first.unit)}</span></div>
      <div class="demo-kpi demo-kpi-secondary"><span class="demo-label">Observation</span><strong data-demo-state>${escapeHTML(first.state)}</strong><span data-demo-status data-tone="${escapeHTML(first.tone)}">${escapeHTML(first.status)}</span></div>
    </div>
    <figure class="demo-plot">
      <figcaption><strong data-demo-signal>${escapeHTML(first.signal)}</strong><span>EXAMPLE SERIES / NOT LIVE</span></figcaption>
      <svg data-demo-svg role="img" aria-label="${escapeHTML(first.signal)}, illustrative data" viewBox="0 0 550 188" preserveAspectRatio="xMidYMid meet">
        <path d="M26 22V162H531" class="demo-axis"/>
        <path d="M26 68H531M26 115H531" class="demo-gridline"/>
        <g data-demo-bars>${first.chart === 'bars' ? barsFor(first.series) : ''}</g>
        <path data-demo-line d="${first.chart === 'bars' ? '' : pathFor(first.series)}" class="demo-line" fill="none"/>
      </svg>
      <p class="demo-no-data" data-demo-empty${first.series.length ? ' hidden' : ''}>No observations for this example state. Check query and provider status.</p>
      <div class="demo-scrub"><label>Inspect observation <input data-demo-inspect type="range" min="0" max="${first.series.length ? first.series.length - 1 : 0}" value="0"${first.series.length ? '' : ' disabled'}/></label>
      <output data-demo-inspection aria-live="polite">${first.series.length ? `Sample 1 of ${first.series.length}: ${escapeHTML(first.series[0])} ${escapeHTML(first.suffix)}` : 'No available observations'}</output></div>
    </figure>
    <div class="demo-query"><span>Evidence / query</span><code data-demo-query>${escapeHTML(first.query)}</code></div>
    <p class="demo-insight" data-demo-note aria-live="polite">${escapeHTML(first.note)}</p>
  </div>
  <div class="demo-foot"><span>Local fixture only. Values, providers and statuses are illustrative.</span>
    <a href="${escapeHTML(prefix)}charts/#charts">Explore Paprika's full chart gallery</a></div>
</section>`;
}

export function renderGalleryPreview(route, prefix = '../../') {
  if (!galleryRoutes.includes(route)) throw new Error('Unknown chart-gallery route: ' + route);
  return `<aside class="article-gallery-preview" data-editorial-gallery aria-label="Interactive chart showcase preview">
  <div class="article-gallery-intro"><div><span class="demo-kicker">REAL PAPRIKA RENDERERS / SYNTHETIC FIXTURES</span>
    <h3>Open the working chart showcase</h3>
    <p>The embedded gallery uses the same chart renderer catalogue as the public showcase. It runs on labelled synthetic data and is separate from your authenticated dashboard workspace.</p></div>
    <a data-gallery-link href="${escapeHTML(prefix)}charts/#${route}">Open the full-screen gallery</a></div>
  <div class="article-gallery-prompt" data-gallery-prompt>
    <span>Browse interactive charts, their tooltips and example configurations.</span>
    <button type="button" data-gallery-launch hidden>Load interactive preview</button>
  </div>
  <iframe data-gallery-frame title="Paprika chart gallery with synthetic data" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" hidden></iframe>
  </aside>`;
}

function mountDemo(root) {
  const key = root.getAttribute('data-editorial-demo');
  const example = examples[key];
  if (!example) return;
  let selected = example.choices[0];
  const get = (selector) => root.querySelector(selector);
  const buttons = Array.from(root.querySelectorAll('[data-demo-choice]'));
  const output = get('[data-demo-inspection]');
  const slider = get('[data-demo-inspect]');
  const line = get('[data-demo-line]');
  const bars = get('[data-demo-bars]');
  const plot = get('[data-demo-svg]');
  const empty = get('[data-demo-empty]');

  const inspect = (index) => {
    if (!selected.series.length) {
      output.textContent = 'No available observations';
      return;
    }
    const position = Math.max(0, Math.min(selected.series.length - 1, Number(index) || 0));
    output.textContent = 'Sample ' + (position + 1) + ' of ' + selected.series.length +
      ': ' + selected.series[position] + ' ' + selected.suffix;
  };

  const select = (choice) => {
    selected = choice;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.demoChoice === selected.key));
    get('[data-demo-value]').textContent = selected.value;
    get('[data-demo-unit]').textContent = selected.unit;
    get('[data-demo-state]').textContent = selected.state;
    const status = get('[data-demo-status]');
    status.textContent = selected.status;
    status.dataset.tone = selected.tone;
    get('[data-demo-signal]').textContent = selected.signal;
    get('[data-demo-note]').textContent = selected.note;
    get('[data-demo-query]').textContent = selected.query;
    plot.setAttribute('aria-label', selected.signal + ', illustrative data');
    line.setAttribute('d', selected.chart === 'bars' ? '' : pathFor(selected.series));
    bars.replaceChildren();
    if (selected.chart === 'bars') {
      const top = Math.max(1, ...selected.series);
      selected.series.forEach((value, index) => {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const height = value / top * 119;
        rect.setAttribute('x', String(28 + index * 40));
        rect.setAttribute('y', String(162 - height));
        rect.setAttribute('width', '26');
        rect.setAttribute('height', String(height));
        rect.setAttribute('rx', '1');
        rect.setAttribute('class', 'demo-bar');
        bars.append(rect);
      });
    }
    empty.hidden = Boolean(selected.series.length);
    slider.max = String(Math.max(0, selected.series.length - 1));
    slider.value = '0';
    slider.disabled = !selected.series.length;
    inspect(0);
  };

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-demo-choice]');
    if (button && root.contains(button)) {
      const choice = example.choices.find((item) => item.key === button.dataset.demoChoice);
      if (choice) select(choice);
    }
    const theme = event.target.closest('[data-demo-theme-toggle]');
    if (theme && root.contains(theme)) {
      const light = root.dataset.demoTheme !== 'light';
      root.dataset.demoTheme = light ? 'light' : 'dark';
      theme.textContent = light ? 'Dark theme' : 'Light theme';
      theme.setAttribute('aria-pressed', String(light));
    }
  });
  slider.addEventListener('input', () => inspect(slider.value));
  plot.addEventListener('pointermove', (event) => {
    if (!selected.series.length) return;
    const bounds = plot.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(bounds.width, 1)));
    const index = Math.round(fraction * (selected.series.length - 1));
    slider.value = String(index);
    inspect(index);
  });
}

function mountGallery(root) {
  const button = root.querySelector('[data-gallery-launch]');
  const anchor = root.querySelector('[data-gallery-link]');
  const frame = root.querySelector('[data-gallery-frame]');
  const prompt = root.querySelector('[data-gallery-prompt]');
  if (!button || !frame || !anchor) return;
  button.hidden = false;
  button.addEventListener('click', () => {
    if (frame.hasAttribute('src')) return;
    const destination = new URL(anchor.href, document.baseURI);
    if (destination.origin !== document.location.origin || !destination.pathname.endsWith('/paprika/charts/')) return;
    frame.src = destination.href;
    frame.hidden = false;
    prompt.hidden = true;
    button.hidden = true;
  }, { once: true });
}

function mount() {
  document.querySelectorAll('[data-editorial-demo]').forEach(mountDemo);
  document.querySelectorAll('[data-editorial-gallery]').forEach(mountGallery);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
