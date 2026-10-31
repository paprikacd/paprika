import { useMemo, useState } from 'react';
import type { DrilldownContext } from '../../vendor/paprika/ui/src/features/insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { DomainChartPanel, DomainHeader, DetailValues, MetricStrip } from '../../components/lab/DomainPrimitives';
import { Panel } from '../../components/lab/StudyPrimitives';
import { registerPerformanceCharts } from '../../charts/performance/register';
import { performanceNumber as fmt, performanceClock } from '../../charts/performance/PerformanceDensity';
import { performanceSpanColor } from '../../charts/performance/PerformanceTrace';
import type { Build } from '../../charts/performance/model';
import { buildPerformanceWorkbench, PERFORMANCE_ROUTES, type PerformanceRoute } from './fixtures';
import '../../charts/performance/performance.css';

registerPerformanceCharts();
type Stage = 'route' | 'trace' | 'function';
type Selection = { request: string; build: Build; span: string; functionId: string; stage: Stage };
const initialSelection: Selection = { request: 'req-217', build: 'after', span: 'serialize', functionId: '', stage: 'route' };

export function PerformanceWorkbenchLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [route, setRoute] = useState<PerformanceRoute>('checkout'), [gaps, setGaps] = useState(false), [selection, setSelection] = useState<Selection>(initialSelection), [history, setHistory] = useState<Selection[]>([]);
  const data = useMemo(() => buildPerformanceWorkbench(route, gaps, selection.request, selection.build), [route, gaps, selection.request, selection.build]);
  const selectedSpan = data.traceData.spans.find(span => span.id === selection.span) ?? data.traceData.spans[0];
  const selectedFunctionId = selection.functionId || data.initialFunction, selectedFunction = data.profileData.frames.find(frame => frame.id === selectedFunctionId);
  const navigate = (next: Partial<Selection>) => { setHistory(previous => [...previous.slice(-19), selection]); setSelection(previous => ({ ...previous, ...next })); };
  const reveal = (stage: Stage) => { const element = document.getElementById(`performance-${stage}-section`); element?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); };
  const choose = (context: DrilldownContext) => {
    const action = context.labels?.action;
    if (action === 'trace' && context.labels?.request) { navigate({ stage: 'trace', request: context.labels.request, build: context.labels.build === 'before' ? 'before' : 'after', span: 'serialize' }); reveal('trace'); }
    else if (action === 'span' && context.labels?.spanId) navigate({ stage: 'trace', span: context.labels.spanId });
    else if (action === 'function') {
      const frame = context.labels?.functionId ? data.profileData.frames.find(item => item.id === context.labels?.functionId) : data.profileData.frames.find(item => item.label === context.labels?.functionName);
      if (frame) { navigate({ stage: 'function', functionId: frame.id, ...(context.labels?.spanId ? { span: context.labels.spanId } : {}) }); reveal('function'); }
    } else if (action === 'profile') { navigate({ stage: 'function' }); reveal('function'); }
  };
  const changeRoute = (next: PerformanceRoute) => { setRoute(next); setSelection(initialSelection); setHistory([]); };
  const p99Change = data.summary.beforeP99 && data.summary.afterP99 ? (data.summary.afterP99 / data.summary.beforeP99 - 1) * 100 : null;
  const traceChoices = [...new Set(['req-217', 'req-083', selection.request])];
  const matchingFunction = selectedSpan?.functionName && data.profileData.frames.find(frame => frame.label === selectedSpan.functionName);
  return <section className="domain-lens performance-workbench" data-domain-lens="performance-workbench">
    <DomainHeader title="Performance Workbench"><label>Route<select aria-label="Performance route" value={route} onChange={event => changeRoute(event.target.value as PerformanceRoute)}>{PERFORMANCE_ROUTES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Baseline<span className="performance-build-label">v2.8.1</span></label><label>Candidate<span className="performance-build-label">v2.8.2</span></label><label>Coverage<select aria-label="Performance coverage" value={gaps ? 'gaps' : 'complete'} onChange={event => setGaps(event.target.value === 'gaps')}><option value="complete">Complete fixture</option><option value="gaps">Missing request metrics</option></select></label></DomainHeader>
    <nav className="performance-breadcrumbs" aria-label="Performance investigation breadcrumb"><button disabled={!history.length} onClick={() => { const previous = history.at(-1); if (previous) { setSelection(previous); setHistory(items => items.slice(0, -1)); } }}>← Back</button><button onClick={() => { setSelection(previous => ({ ...previous, stage: 'route' })); reveal('route'); }}>{data.scope.service}</button><span>/</span><button aria-current={selection.stage === 'route' ? 'step' : undefined} onClick={() => { navigate({ stage: 'route' }); reveal('route'); }}>{data.scope.label}</button><span>/</span><button aria-current={selection.stage === 'trace' ? 'step' : undefined} onClick={() => { navigate({ stage: 'trace' }); reveal('trace'); }}>trace {selection.request}</button>{selection.stage === 'function' && <><span>/</span><button aria-current="step" onClick={() => reveal('function')}>{selectedFunction?.label ?? 'CPU profile'}</button></>}<button className="performance-reset" onClick={() => { setSelection(initialSelection); setHistory([]); }}>Reset investigation</button></nav>
    <MetricStrip items={[
      { label: 'Candidate p99 latency', value: `${fmt(data.summary.afterP99)} ms`, tone: 'amber', detail: `${p99Change === null ? 'Unknown' : `+${fmt(p99Change, 0)}%`} vs baseline · empirical request quantile` },
      { label: 'Baseline p99', value: `${fmt(data.summary.beforeP99)} ms`, detail: 'v2.8.1 · same synthetic request identities' },
      { label: 'Requests / build', value: data.summary.requests, detail: `${data.summary.observed} candidate latency observations` },
      { label: 'Candidate errors', value: `${fmt(data.summary.errors / data.summary.requests * 100, 2)}%`, detail: `${data.summary.errors} of ${data.summary.requests} requests` },
      { label: 'Selected trace', value: `${fmt(data.traceData.duration)} ms`, detail: `${selection.request} · ${selection.build === 'after' ? 'v2.8.2' : 'v2.8.1'} · ${performanceClock(data.selectedObservation.timestamp)} UTC` },
    ]}/>
    <div className="performance-layout">
      <div id="performance-route-section" className="performance-density-panel"><DomainChartPanel panel={data.density} onEdit={onEdit} onContextChange={choose} caption="Two matched synthetic build populations over the same workload timestamps. The heatmap's local time window does not change the full-window comparison metrics."/></div>
      <Panel title="Selected request phase contributions" className="domain-panel performance-phase-panel" actions={<button className="performance-action" onClick={() => { navigate({ stage: 'trace' }); reveal('trace'); }}>View trace →</button>}>
        <div className="performance-phase-scope">{selection.request} · {selection.build === 'after' ? 'Candidate' : 'Baseline'} <strong>{fmt(data.traceData.duration)} ms</strong></div>
        <table className="performance-phase-table"><thead><tr><th>Non-overlapping phase</th><th>Duration</th><th>Share</th></tr></thead><tbody>{[...data.traceData.phases].sort((a, b) => b.duration - a.duration).map(span => <tr key={span.id} data-selected={selection.span === span.id}><td><button onClick={() => { navigate({ stage: 'trace', span: span.id }); reveal('trace'); }}><i style={{ background: performanceSpanColor(span.id) }}/>{span.operation}</button><span className="performance-phase-bar"><i style={{ width: `${span.duration / data.traceData.duration * 100}%`, background: performanceSpanColor(span.id) }}/></span></td><td>{fmt(span.duration)} ms</td><td>{fmt(span.duration / data.traceData.duration * 100)}%</td></tr>)}</tbody><tfoot><tr><td>Accounted phase total</td><td>{fmt(data.traceData.accounted)} ms</td><td>{fmt(data.traceData.accounted / data.traceData.duration * 100)}%</td></tr></tfoot></table>
        <p className="domain-note">These supplied phases partition one sampled request. The aggregate p99 and the selected trace are separate measures.</p>
      </Panel>
      <div id="performance-trace-section" className="performance-trace-panel"><div className="performance-trace-scope"><label>Trace sample<select aria-label="Performance trace request" value={selection.request} onChange={event => navigate({ stage: 'trace', request: event.target.value })}>{traceChoices.map(id => <option key={id} value={id}>{id}</option>)}</select></label><label>Build<select aria-label="Performance trace build" value={selection.build} onChange={event => navigate({ stage: 'trace', build: event.target.value as Build })}><option value="before">Baseline v2.8.1</option><option value="after">Candidate v2.8.2</option></select></label></div>{data.selectedMetricObservation.latency === null && <p className="domain-note" role="status">Request metrics are unavailable for {selection.request} in this build. Its independent trace capture remains available; the missing metrics stay unknown.</p>}<DomainChartPanel panel={data.trace} onEdit={onEdit} selection={{ selectedSpan: selection.span }} onContextChange={choose}/></div>
      <Panel title={`Span details · ${selectedSpan?.operation ?? 'Select a span'}`} className="domain-panel performance-span-panel">
        {selectedSpan && <><div className="performance-span-duration">{fmt(selectedSpan.duration)} <small>ms</small></div><DetailValues items={[["Start offset", `${fmt(selectedSpan.start)} ms`], ['End offset', `${fmt(selectedSpan.end)} ms`], ['Parent', selectedSpan.parentId ?? 'Request root'], ['Service', selectedSpan.service], ['Span kind', selectedSpan.phase ? 'Supplied request phase' : 'Inclusive nested work'], ['Status', selectedSpan.status], ['http.route', data.scope.label], ['Trace ID', selectedSpan.traceId], ['Related CPU symbol', selectedSpan.functionName ?? 'No mapped function']]}/>{matchingFunction && <button className="performance-action" onClick={() => { navigate({ stage: 'function', functionId: matchingFunction.id }); reveal('function'); }}>Inspect {matchingFunction.label} →</button>}<p className="domain-note">The CPU link opens aggregate costs for the same service/function. It does not assign the whole profile cost to this one request.</p></>}
      </Panel>
      <div id="performance-function-section" className="performance-profile-panel"><DomainChartPanel panel={data.profile} onEdit={onEdit} selection={{ selectedId: selectedFunctionId }} onContextChange={choose} caption="Complete independent CPU-profile fixture coverage: 480 requests per build. Request-metric gaps do not erase these supplied profile costs. Native differential Pyroscope imports are not implied."/></div>
      <DomainChartPanel panel={data.evidence} className="performance-evidence-panel" onEdit={onEdit} onContextChange={choose} caption="Before/after means and intervals derive from matched complete request pairs. This is controlled synthetic evidence, not a claim that a deployment caused a production change."/>
    </div>
    <footer className="performance-lens-footer">Concept · synthetic matched workload · 480 identities per build · request → trace → CPU symbol → paired evidence</footer>
  </section>;
}
