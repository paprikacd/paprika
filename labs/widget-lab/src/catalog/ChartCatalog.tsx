import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Braces, FlaskConical, Moon, Sun } from 'lucide-react';
import { registerConceptCharts } from '../charts/register-concept-charts';
import { ChartCursorProvider, useChartCursor } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { getWidgetDefinition } from '../vendor/paprika/ui/src/features/insights/widget-registry';
import type { DrilldownContext } from '../vendor/paprika/ui/src/features/insights/drilldown';
import { useInsightsTheme } from '../vendor/paprika/ui/src/features/insights/insights-theme';
import themeStyles from '../vendor/paprika/ui/src/features/insights/gamma/gamma-theme.module.css';
import { allChartCatalog as chartCatalog, makeCatalogFixture, type CatalogId, type CatalogPreset } from './chart-fixtures';
import { DashboardEditControls, useDashboardPanels } from '../components/lab/DashboardWorkbench';
import './ChartCatalog.css';
import { hasIntrinsicChartLayout } from '../charts/intrinsic-chart-families';
import { labMotionStyle, useLabMotion } from '../components/lab/motion';

registerConceptCharts();

function SelectionReadout({ context, clear }: { context: DrilldownContext | null; clear: () => void }) {
  const cursor = useChartCursor();
  const hasContext = context && Object.keys(context).length > 0;
  return <section className="catalog-context" aria-label="Selected chart context">
    <header><h3>Selection context</h3>{hasContext && <button onClick={clear}>Clear readout</button>}</header>
    <p>{cursor ? `${cursor.pinned ? 'Pinned' : 'Inspecting'} ${new Date(cursor.timestamp).toISOString()} · UTC` : 'Select a mark to inspect the emitted context.'}</p>
    {hasContext ? <dl><div><dt>Series / entity</dt><dd>{context.series ?? '—'}</dd></div><div><dt>Exact value</dt><dd>{context.value === null ? 'No observed value' : context.value ?? 'Not supplied'}</dd></div>{Object.entries(context.labels ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <span className="catalog-muted">No deliberate selection yet.</span>}
  </section>;
}

export function ChartCatalog() {
  const motion = useLabMotion();
  const [selected, setSelected] = useState<CatalogId>('connection-map');
  const [preset, setPreset] = useState<CatalogPreset>('ready');
  const [loadingState, setLoadingState] = useState<'ready' | 'loading' | 'refreshing'>('ready');
  const [width, setWidth] = useState<'wide' | 'narrow'>('wide');
  const [context, setContext] = useState<DrilldownContext | null>(null);
  const panels = useDashboardPanels();
  const { resolvedTheme, setTheme } = useInsightsTheme();
  const feature = chartCatalog.find(item => item.id === selected)!;
  const fixture = useMemo(() => makeCatalogFixture(selected, preset), [selected, preset]);
  const activeWidget = panels.current(fixture.widget);
  const definition = getWidgetDefinition(activeWidget);
  const parsedConfig = useMemo(() => definition?.parseConfig?.(activeWidget.config) ?? activeWidget.config ?? {}, [definition, activeWidget]);
  useEffect(() => { setContext(null); }, [fixture.result]);
  const choose = (id: CatalogId) => { setSelected(id); setPreset('ready'); setLoadingState('ready'); setContext(null); panels.closeEditor(); };
  return <div className={`${themeStyles.scope} obs-app chart-catalog`} data-insights-theme={resolvedTheme} data-motion={motion.reduced ? 'reduced' : 'auto'} style={labMotionStyle(motion.reduced)}>
    <header className="catalog-header">
      <a href="#edge" className="catalog-back"><ArrowLeft size={16}/>Dashboard studies</a>
      <div className="catalog-title"><span>PAPRIKA / CHART LIBRARY</span><h1>Working chart coverage</h1></div>
      <DashboardEditControls/>
      <span className="catalog-fixture"><FlaskConical size={14}/>Synthetic data</span>
      <button className="catalog-theme" aria-label={`Switch catalogue to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{resolvedTheme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</button>
    </header>
    <div className="catalog-layout">
      <nav className="catalog-nav" aria-label="Chart families"><label className="catalog-family-select">Chart family<select aria-label="Choose chart family" value={selected} onChange={event => choose(event.target.value as CatalogId)}>{[...new Set(chartCatalog.map(item=>item.group??'Core charts'))].map(group => <optgroup key={group} label={group}>{chartCatalog.filter(item => (item.group ?? 'Core charts') === group).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>)}</select></label><p>{chartCatalog.length} working examples</p>{chartCatalog.map((item, index) => <Fragment key={item.id}>{(index === 0 || item.group !== chartCatalog[index - 1].group) && <h2 className="catalog-nav-group">{item.group ?? 'Core charts'}</h2>}<button onClick={() => choose(item.id)} aria-pressed={selected === item.id}><span>{String(index + 1).padStart(2, '0')}</span>{item.label}</button></Fragment>)}<div className="catalog-nav-note">Existing Paprika hosts, normalized data and trusted renderer extensions.<a href="#reliability">Reference composition<ArrowUpRight size={12}/></a></div></nav>
      <main className="catalog-main">
        <div className="catalog-feature-heading"><div><p className="catalog-eyebrow">{feature.owner}</p><h2>{feature.question}</h2></div><span className="catalog-registration">{definition ? 'Registered' : 'Unavailable'}</span></div>
        <div className="catalog-controls">
          <label>Fixture<select aria-label="Chart fixture" value={preset} onChange={event => { setPreset(event.target.value as CatalogPreset); setLoadingState('ready'); }}>{feature.presets.map(value => <option key={value} value={value}>{value === 'ready' ? 'Observed data' : value === 'gaps' ? 'Missing observations' : value === 'empty' ? 'Empty result' : 'Query failure'}</option>)}</select></label>
          <label>Loading preview<select aria-label="Chart loading state" disabled={preset === 'error'} title={preset === 'error' ? 'Choose a data fixture to preview loading.' : undefined} value={loadingState} onChange={event => { setLoadingState(event.target.value as typeof loadingState); if (event.target.value === 'loading') { setContext(null); panels.closeEditor(); } }}><option value="ready">Ready</option><option value="loading">Initial loading</option><option value="refreshing">Refreshing existing data</option></select></label>
          <label>Motion<select aria-label="Chart motion preference" value={motion.preference} onChange={event => motion.setPreference(event.target.value as 'auto' | 'reduced')}><option value="auto">Auto{motion.reduced && motion.preference === 'auto' ? ' · system reduced' : ''}</option><option value="reduced">Reduced</option></select></label>
          <div className="catalog-width" role="group" aria-label="Panel width"><button aria-pressed={width === 'wide'} onClick={() => setWidth('wide')}>Wide panel</button><button aria-pressed={width === 'narrow'} onClick={() => setWidth('narrow')}>Narrow panel</button></div>
          {feature.lensHref && <a className="catalog-lens-link" href={feature.lensHref}>Open {feature.group}<ArrowUpRight size={12}/></a>}<span>{feature.group ? 'Reference dark theme · source data unchanged' : 'Presentation changes keep the same source data.'}</span>
        </div>
        <ChartCursorProvider key={selected}>
          <section className={`catalog-preview ${width === 'narrow' ? 'is-narrow' : ''} ${feature.group ? `${themeStyles.scope} is-concept` : ''}`} data-insights-theme={feature.group ? 'dark' : undefined} style={feature.group ? labMotionStyle(motion.reduced) : undefined} aria-label={`${feature.label} working preview`}>
            <header><h3>{activeWidget.title}</h3><div className="catalog-panel-actions"><span>{activeWidget.unit || activeWidget.dataKind}</span>{panels.actions(fixture)}</div></header>{activeWidget.description&&<p className="catalog-panel-description">{activeWidget.description}</p>}
            <div className="catalog-chart-body" data-catalog-family={panels.overrides[fixture.widget.id] ? (activeWidget.pluginId ?? activeWidget.type) : selected} data-catalog-expanded={hasIntrinsicChartLayout(activeWidget)}><WidgetVisualization widget={activeWidget} result={loadingState === 'loading' ? undefined : fixture.result} loading={loadingState !== 'ready'} error={preset === 'error' ? 'Synthetic provider failure. Choose Observed data to recover the same chart.' : undefined} onContextChange={setContext}/></div>
          </section>
          <div className="catalog-explanation"><section><h3>Data contract</h3><p>{feature.contract}</p><h3>Try the interaction</h3><p>{feature.inspect}</p>{feature.localExtension && <p className="catalog-extension"><strong>Local extension:</strong> {feature.localExtension}</p>}</section><SelectionReadout context={context} clear={() => setContext(null)}/></div>
        </ChartCursorProvider>
        <details className="catalog-source"><summary><Braces size={16}/>Configuration and normalized input</summary><div><section><h3>Validated widget configuration</h3><pre>{JSON.stringify({ ...activeWidget, config: parsedConfig }, null, 2)}</pre></section><section><h3>Complete deterministic result</h3><pre>{JSON.stringify(fixture.result, null, 2)}</pre></section></div></details>
        <p className="catalog-footnote">{chartCatalog.length} working examples use the same widget host and editor. Loading preview holds a simulated request state until you choose Ready; it never fetches data or changes the source values. Concept families keep their reference dark theme and deterministic fixtures. These examples do not establish live-provider or production performance coverage.</p>
      </main>
    </div>
  </div>;
}
