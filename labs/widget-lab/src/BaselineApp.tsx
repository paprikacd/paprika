import { DashboardEditControls, useDashboardPanels } from './components/lab/DashboardWorkbench';
import { useGammaScope } from './components/lab/appearance';
import { useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronRight, FlaskConical, GitCommitHorizontal, Info, Maximize2, Minimize2, RefreshCw, TableProperties, X, TriangleAlert } from 'lucide-react';
import { ChartCursorProvider } from '@insights/chart-cursor';
import { WidgetVisualization } from './renderer-extensions/charts';
import { GammaButton } from '@insights/gamma/button';
import { GammaSelect } from '@insights/gamma/select';
import gammaTheme from '@insights/gamma/gamma-theme.module.css';
import { registerRichMetricPlugins } from './renderer-extensions/plugins/rich-metrics';
import { aggregateTimeline, buildTelemetry, REGIONS, selectTelemetry, summarize, type RegionId, type Scenario } from './data/telemetry';
import { makeChartResults, LATENCY_WIDGET, TRAFFIC_WIDGET, ERROR_WIDGET, DISTRIBUTION_WIDGET } from './data/chart-adapter';
import { RegionalLatency } from './components/RegionalLatency';
import { Panel } from './components/Panel';
import { ObservationBar } from './components/ObservationBar';
import { ExactData } from './components/ExactData';
import { calendarDate, clockTime, integer, latency, percentage, rate, signedPercent, TIMEZONE } from './format';

registerRichMetricPlugins();

const SCENARIOS = [
  { value: 'regression', label: 'Deployment regression', description: 'A regional latency change with complete telemetry.' },
  { value: 'gaps', label: 'Missing samples', description: 'An internal gap and three missing final intervals.' },
  { value: 'quiet', label: 'Quiet service', description: 'Sparse requests, real zero traffic, and undefined percentiles.' },
];
const REGION_OPTIONS = [{ value: 'all', label: 'All regions' }, ...REGIONS.map(region => ({ value: region.id, label: region.shortLabel, description: region.id }))];

export function BaselineApp() {
  const panels = useDashboardPanels();
  const scope = useGammaScope();
  const [scenario, setScenario] = useState<Scenario>('regression');
  const [region, setRegion] = useState<RegionId | 'all'>('all');
  const [minutes, setMinutes] = useState<15 | 30 | 60>(60);
  const [revision, setRevision] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [showData, setShowData] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [panelState, setPanelState] = useState<'ready' | 'loading' | 'error' | 'empty'>('ready');
  const dataRef = useRef<HTMLElement>(null);

  const dataset = useMemo(() => buildTelemetry(scenario, revision), [scenario, revision]);
  const selected = useMemo(() => selectTelemetry(dataset, { region, minutes }), [dataset, region, minutes]);
  const timeline = useMemo(() => aggregateTimeline(selected), [selected]);
  const summary = useMemo(() => summarize(selected), [selected]);
  const results = useMemo(() => makeChartResults(selected), [selected]);
  const regionSummary = useMemo(() => summarize(selectTelemetry(dataset, { minutes })), [dataset, minutes]);
  const regionItems = useMemo(() => regionSummary.perRegion.map(item => ({
    id: item.region, name: item.shortLabel, code: item.region, requests: item.totalRequests, p50Ms: item.p50Ms,
    p95Ms: item.p95Ms, errorRatio: item.errorRatio, coverage: item.coverageRatio,
  })), [regionSummary]);
  const scopeKey = `${scenario}-${region}-${minutes}-${revision}-${panelState}`;
  const comparison = summary.comparison;
  const comparisonPartial = comparison.before.coverageRatio < 1 || comparison.after.coverageRatio < 1;
  const selectedRegionName = REGIONS.find(item => item.id === region)?.shortLabel;
  const emptyResult = useMemo(() => ({ series: [] }), []);
  const latencyResult = panelState === 'loading' ? undefined : panelState === 'empty' ? emptyResult : results.latency;
  const staleMinutes = summary.lastObservedMs === null ? null : (selected.endMs - summary.lastObservedMs) / 60_000;
  const eventRatio = (selected.deploymentMs - selected.startMs) / (selected.endMs - selected.startMs);
  const showEvent = eventRatio >= 0 && eventRatio <= 1;
  function revealData() {
    setShowData(previous => !previous);
    if (!showData) requestAnimationFrame(() => dataRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
  }
  function changeScenario(value: string) { setScenario(value as Scenario); setRevision(0); setPanelState('ready'); }

  return <div className={`${gammaTheme.scope} lab-app`} {...scope}>
    <a className="skip-link" href="#dashboard">Skip to widgets</a>
    <header className="topbar">
      <div className="brand"><span className="wordmark">paprika</span><span className="brand-divider" /><span>Insights</span><ChevronRight size={14} /><strong>Widget lab</strong></div>
      <div className="top-actions"><DashboardEditControls/><span className="synthetic-label"><FlaskConical size={14} />Synthetic telemetry</span></div>
    </header>

    <main className="workspace">
      <div className="page-heading"><div><h1>Checkout deployment review</h1><p>Five widgets. One investigation. Follow a change from signal to evidence.</p></div><div className="heading-actions"><GammaButton variant="ghost" size="sm" aria-expanded={showGuide} aria-controls="evaluation-guide" onClick={() => setShowGuide(!showGuide)}><Info size={15} />Evaluation guide</GammaButton><GammaButton variant="secondary" size="sm" aria-expanded={showData} aria-controls="exact-data" onClick={revealData}><TableProperties size={15} />{showData ? 'Hide data' : 'Exact data'}</GammaButton></div></div>

      {showGuide && <section id="evaluation-guide" className="evaluation-guide" aria-label="Evaluation guide">
        <div className="guide-intro"><h2>What to evaluate</h2><GammaButton variant="ghost" size="sm" iconOnly aria-label="Close evaluation guide" onClick={() => setShowGuide(false)}><X size={15} /></GammaButton></div>
        <div className="guide-grid"><div><strong>Read the change</strong><p>Compare the p95 and p50, then select Sydney to isolate the regional shift. The deployment is temporal context.</p></div><div><strong>Inspect the evidence</strong><p>Use pointer or keyboard inspection and the exact-data view. Percentiles are pooled histogram estimates; ratios are weighted by request counts.</p></div><div><strong>Stress the widgets</strong><p>Switch to missing samples or a quiet service. Change the canvas width, theme, or snapshot and check the same measurements.</p></div></div>
        <div className="state-controls"><span>Latency panel state</span><div role="group" aria-label="Latency panel state">{(['ready','loading','error','empty'] as const).map(state => <GammaButton key={state} size="sm" variant={panelState === state ? 'primary' : 'secondary'} aria-pressed={panelState === state} onClick={() => setPanelState(state)}>{state === 'ready' ? 'Data' : state[0].toUpperCase() + state.slice(1)}</GammaButton>)}</div></div>
        <p className="guide-provenance">Uses Paprika’s actual TanStack chart host, Gamma controls and distribution renderer, plus a new regional range component. All measurements are deterministic fixtures. Loading, empty and error controls affect only the latency panel.</p>
      </section>}

      <div className="toolbar" aria-label="Dashboard scope">
        <div className="toolbar-field scenario-field"><label id="scenario-label">Fixture</label><GammaSelect aria-labelledby="scenario-label" value={scenario} options={SCENARIOS} onValueChange={changeScenario} size="sm" /></div>
        <div className="toolbar-field region-field"><label id="region-label">Region</label><GammaSelect aria-labelledby="region-label" value={region} options={REGION_OPTIONS} onValueChange={value => setRegion(value as RegionId | 'all')} size="sm" /></div>
        <div className="toolbar-divider" />
        <div className="range-buttons" role="group" aria-label="Time window">{([15,30,60] as const).map(value => <GammaButton key={value} size="sm" variant={minutes === value ? 'primary' : 'ghost'} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value}m</GammaButton>)}</div>
        <div className="toolbar-end"><GammaButton variant="ghost" size="sm" onClick={() => setNarrow(!narrow)} aria-pressed={narrow}>{narrow ? <Maximize2 size={14} /> : <Minimize2 size={14} />}{narrow ? 'Wide canvas' : 'Narrow canvas'}</GammaButton><GammaButton variant="secondary" size="sm" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />Next snapshot</GammaButton></div>
      </div>
      <div className="scope-line"><div><span className="service-name">checkout-api</span><span>{selectedRegionName || '3 regions'}</span><span>{calendarDate(selected.endMs)}</span><span>{clockTime(selected.startMs)}–{clockTime(selected.endMs)} · {TIMEZONE}</span></div><span className="snapshot-label" aria-live="polite">Snapshot {revision + 1} · one-minute intervals</span></div>

      {summary.coverageRatio < 1 && <div className="coverage-notice" role="status"><TriangleAlert size={16} /><div><strong>{Math.round(summary.coverageRatio * 100)}% of regional intervals observed.</strong> Gaps remain missing. Window summaries use observed requests.{staleMinutes !== null && staleMinutes > 0 && ` The newest observed data is ${staleMinutes} minutes before the window end.`}</div></div>}
      {scenario === 'quiet' && <div className="quiet-notice"><Info size={16} /><span>Only {integer(summary.totalRequests)} requests in this window. Zero-traffic intervals have no latency percentile or error ratio.</span></div>}

      <div className={`canvas-container ${narrow ? 'is-narrow' : ''}`}>
        <ChartCursorProvider key={scopeKey}>
          <div id="dashboard" className="dashboard" tabIndex={-1}>
            <div className="primary-grid">
              <Panel id="latency" title={panels.current(LATENCY_WIDGET).title} description="p95 and p50 · pooled one-minute histograms" className="latency-panel" action={<><span className="panel-tag">Milliseconds</span>{panels.actions({widget:LATENCY_WIDGET,result:latencyResult??results.latency})}</>}>
                <div className="latency-summary"><div className="metric-block"><span className="metric-label">Window p95</span><div className="metric-value" data-testid="latency-summary">{panelState === 'ready' ? latency(summary.p95Ms) : '—'}<span>ms</span></div></div><div className="comparison-block">{panelState === 'ready' ? <><div className="comparison-values"><span>{latency(comparison.before.p95Ms)}</span><ArrowRight size={15} /><strong>{latency(comparison.after.p95Ms)} ms</strong><span className="change-label">{comparisonPartial ? 'Partial comparison' : <>{comparison.p95RelativeChange !== null && comparison.p95RelativeChange > 0 && <ArrowUpRight size={13} />}{signedPercent(comparison.p95RelativeChange)}</>}</span></div><span>Earlier vs later {comparison.durationMs / 60_000}-minute windows{comparison.excludedLeadingMs > 0 ? ' · first minute excluded' : ''}</span>{comparisonPartial && <span>Observed requests · coverage {(comparison.before.coverageRatio * 100).toFixed(1)}% → {(comparison.after.coverageRatio * 100).toFixed(1)}%</span>}</> : <span>Previewing the {panelState} state</span>}</div></div>
                <div className="event-note"><GitCommitHorizontal size={15} /><span><strong>v2.8.1</strong> deployed at {clockTime(selected.deploymentMs)}{!showEvent && ' · outside this window'}</span><span>Context, not attribution</span></div>
                <div className="chart-box primary-chart">
                  <WidgetVisualization widget={panels.current(LATENCY_WIDGET)} result={latencyResult} loading={panelState === 'loading'} error={panelState === 'error' ? 'Synthetic provider unavailable. Restore the Data state in the evaluation guide.' : undefined} />
                  {showEvent && panelState === 'ready' && <span aria-hidden="true" className="deployment-guide" style={{ left: `calc(${eventRatio * 100}% + ${54 - 66 * eventRatio}px)` }} />}
                </div>
                <div className="panel-footnote"><span>Percentiles are histogram estimates.</span><span>{summary.complete ? 'Complete coverage' : `${Math.round(summary.coverageRatio * 100)}% observed coverage`}</span></div>
              </Panel>
              <Panel id="regions" title="Where is the tail?" description={`Regional p50 → p95 · ${minutes}-minute window`} className="region-panel" action={region !== 'all' ? <GammaButton size="sm" variant="ghost" onClick={() => setRegion('all')}>Clear</GammaButton> : undefined}>
                <RegionalLatency items={regionItems} selectedRegion={region} onSelect={value => setRegion(value as RegionId | 'all')} />
              </Panel>
            </div>

            <ObservationBar timeline={timeline} />

            <div className="signals-grid">
              <Panel id="traffic" title={panels.current(TRAFFIC_WIDGET).title} action={panels.actions({widget:TRAFFIC_WIDGET,result:results.traffic})} description="One-minute request counts ÷ 60 seconds" className="traffic-panel">
                <div className="signal-summary"><div className="signal-value" data-testid="traffic-summary">{rate(summary.meanRequestRate)}<span>req/s</span></div><span>Mean of complete intervals</span><strong>{integer(summary.totalRequests)} requests observed</strong></div>
                <div className="chart-box signal-chart"><WidgetVisualization widget={panels.current(TRAFFIC_WIDGET)} result={results.traffic} /></div>
              </Panel>
              <Panel id="error-rate" title={panels.current(ERROR_WIDGET).title} action={panels.actions({widget:ERROR_WIDGET,result:results.errors})} description="Failed requests ÷ total requests" className="error-panel">
                <div className="signal-summary"><div className="signal-value" data-testid="error-summary">{percentage(summary.errorRatio)}</div><span>Weighted over this window</span><strong>{integer(summary.totalErrors)} failed requests</strong></div>
                <div className="chart-box signal-chart"><WidgetVisualization widget={panels.current(ERROR_WIDGET)} result={results.errors} /></div>
              </Panel>
            </div>

            <Panel id="distribution" title={panels.current(DISTRIBUTION_WIDGET).title} description="Request counts per latency bucket, per minute" action={<><span className="panel-tag">Count density</span>{panels.actions({widget:DISTRIBUTION_WIDGET,result:results.distribution})}</>}>
              <div className="chart-box distribution-chart"><WidgetVisualization widget={panels.current(DISTRIBUTION_WIDGET)} result={results.distribution} /></div>
              <div className="panel-footnote"><span>Discrete latency buckets · color encodes request count.</span><span>Missing cells are outlined; observed zero is a value.</span></div>
            </Panel>
          </div>
        </ChartCursorProvider>
      </div>

      {showData && <section id="exact-data" className="panel exact-data" ref={dataRef} aria-labelledby="exact-data-heading"><header className="panel-heading"><div><h2 id="exact-data-heading">Exact interval data</h2><p>{selectedRegionName || 'All regions'} · {timeline.length} intervals · same source values as the charts</p></div><GammaButton size="sm" variant="ghost" onClick={() => setShowData(false)} aria-label="Close exact data"><X size={15} />Close</GammaButton></header><ExactData timeline={timeline} /></section>}
      <footer className="page-footer"><span>Paprika Dashboard Design · component evaluation</span><span>Deterministic fixtures · no live services connected</span></footer>
    </main>
  </div>;
}
