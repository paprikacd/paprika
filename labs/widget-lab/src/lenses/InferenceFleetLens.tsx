import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowRightLeft, Clock3, Cpu, Database, RotateCcw } from 'lucide-react';
import { registerInferenceCharts } from '../charts/inference/register';
import { registerLabCharts } from '../charts/register-lab-charts';
import { Panel } from '../components/lab/StudyPrimitives';
import { WidgetVisualization } from '../renderer-extensions/charts';
import { ChartCursorProvider } from '@insights/chart-cursor';
import { horizontalPlotBounds } from '../renderer-extensions/chart-presentation';
import { formatWindowDuration, minimumTimeWindow, timeWindowExtent, type ChartTimeWindow } from '../renderer-extensions/time-window';
import { TimeBrushOverlay, TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../renderer-extensions/time-window-controls';
import type { Widget } from '../renderer-extensions/schema';
import type { EditLensWidget } from './LensStudio';
import { buildInferenceFleet, inferenceObservationWindow, inferenceResultInWindow, INFERENCE_MODELS, INFERENCE_REGIONS, type InferencePanel, type InferenceScope } from './inference-fleet-data';
import './InferenceFleetLens.css';

registerLabCharts();
registerInferenceCharts();
const compact = (value: number) => value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toLocaleString();
const utcTime = (timestamp: number) => new Date(timestamp).toISOString().slice(11, 16);

interface PairPlotGeometry {
  offsetX: number; offsetY: number; scaleX: number; scaleY: number;
  width: number; height: number; top: number; bottom: number;
}

/** One pointer owner per physical plot; both commit to the same parent window. */
function InferenceTimePlot({ panel, kind, window, revision, enabled, commit, onBrushStart }: {
  panel: InferencePanel; kind: 'histogram' | 'queue'; window: ChartTimeWindow;
  revision: unknown; enabled: boolean; commit: (window: ChartTimeWindow) => boolean; onBrushStart: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<PairPlotGeometry | null>(null);
  const point = (clientX: number, clientY: number) => {
    const container = root.current, svg = container?.querySelector('svg');
    if (!container || !svg) return null;
    const transform = svg.getScreenCTM(), box = svg.getBoundingClientRect(), rootBox = container.getBoundingClientRect();
    if (!transform || !box.width || !box.height || !rootBox.width || !rootBox.height) return null;
    const width = svg.viewBox.baseVal.width || svg.width.baseVal.value || box.width;
    const height = svg.viewBox.baseVal.height || svg.height.baseVal.value || box.height;
    const coordinate = new DOMPoint(clientX, clientY).matrixTransform(transform.inverse());
    const { left, right, plotWidth } = horizontalPlotBounds(width, 110, 12);
    const top = kind === 'histogram' ? 4 : panel.widget.unit.length > 6 || panel.widget.options?.axisUnit === 'caption' ? 20 : height < 130 ? 4 : 10;
    const bottom = kind === 'histogram' ? 24 : panel.widget.options?.xAxisLabel ? 47 : 29;
    // Convert the SVG's actual transform into its HTML wrapper for the preview.
    // The cursor timestamp continues to use SVG plot coordinates, never an index.
    const rootScaleX = container.clientWidth / rootBox.width, rootScaleY = container.clientHeight / rootBox.height;
    const next = { width, height, top, bottom, offsetX: (box.left - rootBox.left) * rootScaleX, offsetY: (box.top - rootBox.top) * rootScaleY, scaleX: box.width / width * rootScaleX, scaleY: box.height / height * rootScaleY };
    setGeometry(previous => previous && Object.keys(next).every(key => previous[key as keyof PairPlotGeometry] === next[key as keyof PairPlotGeometry]) ? previous : next);
    const x = Math.max(left, Math.min(width - right, coordinate.x));
    return { x, y: coordinate.y, inPlot: coordinate.x >= left && coordinate.x <= width - right && coordinate.y >= top && coordinate.y <= height - bottom,
      timestamp: window.start + (x - left) / Math.max(1, plotWidth) * (window.end - window.start) };
  };
  const brush = useTimeWindowBrush({ enabled, revision, window, point, commit, onStart: onBrushStart });
  const preview = brush.preview && geometry ? { ...brush.preview, x1: geometry.offsetX + brush.preview.x1 * geometry.scaleX, x2: geometry.offsetX + brush.preview.x2 * geometry.scaleX } : null;
  const presentedWidget = useMemo(() => brush.preview ? { ...panel.widget, options: { ...panel.widget.options, showTooltip: false } } : panel.widget, [panel.widget, !!brush.preview]);
  return <div ref={root} className={kind === 'histogram' ? 'inference-latency-chart' : 'inference-queue-chart'} data-inference-window-plot={kind}
    role="group" aria-label={`${panel.widget.title}. Drag to change the shared latency and queue window, or use Time window.`}
    {...brush.handlers}
    onPointerDownCapture={event => {
      const target = event.target as Element, svg = target.closest('svg');
      // Ignore inline inspector miniatures and controls. The canonical queue's
      // independent brush must not also claim a gesture owned by this pair.
      if (!enabled || event.button !== 0 || !event.isPrimary || svg !== root.current?.querySelector('svg') || target.closest('button,input,select,summary,a,[role=slider]')) return;
      if (!point(event.clientX, event.clientY)?.inPlot) return;
      brush.handlers.onPointerDownCapture(event);
      event.stopPropagation();
    }}>
    <WidgetVisualization widget={presentedWidget} result={panel.result}/>
    {geometry && <TimeBrushOverlay preview={preview} top={geometry.offsetY + geometry.top * geometry.scaleY} height={Math.max(0, (geometry.height - geometry.top - geometry.bottom) * geometry.scaleY)} width={geometry.width * geometry.scaleX}/>}
  </div>;
}

function InferenceLatencyPair({ histogram, queue, times, edit }: { histogram: InferencePanel; queue: InferencePanel; times: number[]; edit: (panel: InferencePanel) => ReactNode }) {
  const sourceRevision = useMemo(() => ({ histogram: histogram.result, queue: queue.result }), [histogram.result, queue.result]);
  const sourceSeries = useMemo(() => [...(histogram.result.series ?? []), ...(queue.result.series ?? [])], [sourceRevision]);
  const extent = useMemo(() => timeWindowExtent(sourceSeries), [sourceSeries]);
  const minimumSpan = useMemo(() => extent ? minimumTimeWindow(sourceSeries, extent) : 1, [sourceSeries, extent]);
  const windowState = useChartTimeWindow(extent, sourceRevision, minimumSpan);
  const commit = useCallback((candidate: ChartTimeWindow) => {
    const accepted = inferenceObservationWindow(candidate, times, minimumSpan);
    return !!accepted && windowState.commit(accepted);
  }, [times, minimumSpan, windowState.commit]);
  // Source replacement is the canonical invalidation path for both inspectors.
  // Keep it independent from the brush revision so pointer capture survives.
  const [inspectionRevision, setInspectionRevision] = useState(0);
  const onBrushStart = useCallback(() => setInspectionRevision(previous => previous + 1), []);
  const visibleHistogram = useMemo(() => ({ ...histogram, widget: { ...histogram.widget, options: { ...histogram.widget.options, timeAxis: 'calendar' as const, plotInsetLeft: 110, plotInsetRight: 12 } }, result: inferenceResultInWindow(histogram.result, windowState.window) }), [histogram.widget, histogram.result, windowState.window.start, windowState.window.end, inspectionRevision]);
  const visibleQueue = useMemo(() => ({ ...queue, widget: { ...queue.widget, options: { ...queue.widget.options, timeAxis: 'calendar' as const, plotInsetLeft: 110, plotInsetRight: 12 } }, result: inferenceResultInWindow(queue.result, windowState.window) }), [queue.widget, queue.result, windowState.window.start, windowState.window.end, inspectionRevision]);
  const visibleTimes = visibleQueue.result.series?.[0]?.points ?? [];
  const missingTimes = visibleTimes.filter(point => point.value === null);
  const rangeLabel = `${utcTime(windowState.window.start)}–${utcTime(windowState.window.end)} UTC`;
  return <Panel title={histogram.widget.title} subtitle="Pooled compatible cumulative TTFT histogram buckets, differenced once into disjoint rates. Bucket boundaries are approximately logarithmically spaced; color shows requests/s per bucket, not density per millisecond. The histogram and queue share their exact timestamp domain and a reversible view window. Snapshot KPIs retain the selected region and model." actions={edit(visibleHistogram)} className="inference-latency-panel">
    <div className="inference-paired-window" data-inference-paired-start={windowState.window.start} data-inference-paired-end={windowState.window.end}>
      <div className="inference-paired-caption"><span>Linked latency + queue</span><span>{rangeLabel}</span></div>
      <TimeWindowControls state={{ ...windowState, commit }} description="Changes the latency histogram and queue together. Bounds snap outwards to five-minute source observations; no values are interpolated. Undo restores the previous accepted pair window. Reset restores the loaded range and clears its history. Dashboard scope, summaries and source observations stay unchanged."/>
    </div>
    <InferenceTimePlot panel={visibleHistogram} kind="histogram" window={windowState.window} revision={sourceRevision} enabled={windowState.enabled} commit={commit} onBrushStart={onBrushStart}/>
    <div className="inference-queue-heading"><h3>{queue.widget.title}</h3><span>{formatWindowDuration(windowState.window.end - windowState.window.start)} view · five-minute samples</span>{edit(visibleQueue)}</div>
    <InferenceTimePlot panel={visibleQueue} kind="queue" window={windowState.window} revision={sourceRevision} enabled={windowState.enabled} commit={commit} onBrushStart={onBrushStart}/>
    <p className="inference-latency-note" role="status">{rangeLabel} · {visibleTimes.length} source timestamps{missingTimes.length ? ` · ${utcTime(missingTimes[0].timestamp)}–${utcTime(missingTimes.at(-1)!.timestamp)} missing` : ''} · bounds snap to 5m</p>
  </Panel>;
}

export function InferenceFleetLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [scope, setScope] = useState<InferenceScope>({ region: 'all', model: 'all', hours: 6 });
  const data = useMemo(() => buildInferenceFleet(scope), [scope]);
  const panels = useDashboardPanels(onEdit);
  const current = (panel: InferencePanel) => panels.current(panel.widget);
  const edit = panels.actions;
  const visual = (panel: InferencePanel) => <WidgetVisualization widget={current(panel)} result={panel.result}/>;
  const metrics = [{ label: 'Reporting capacity', value: `${data.summary.online}`, unit: `/ ${data.summary.gpus} GPUs`, icon: Cpu }, { label: 'Original requests', value: compact(data.summary.requestRate), unit: 'req/s', icon: ArrowRightLeft }, { label: 'Output throughput', value: compact(data.summary.tokens), unit: 'tokens/s', icon: Database }, { label: 'Pooled p95 TTFT', value: data.summary.p95 === null ? '—' : data.summary.p95.toFixed(0), unit: 'ms', icon: Clock3 }];
  return <main className="inference-lens">
    <header className="inference-heading"><div><p>PAPRIKA / COMPUTE</p><h1>Inference Fleet</h1><span><Activity size={12}/>gpu-prod-03 <i/> Concept • synthetic data</span></div><div className="inference-snapshot"><span><i/>{data.summary.gpus - data.summary.online} devices lack telemetry</span><small>31 Oct 2026 · 16:00 UTC</small></div></header>
    <div className="inference-scope-strip"><div className="inference-scope-controls"><label>Region<select aria-label="Inference region" value={scope.region} onChange={event => setScope(previous => ({ ...previous, region: event.target.value }))}><option value="all">All regions</option>{INFERENCE_REGIONS.map(region => <option key={region}>{region}</option>)}</select></label><label>Models<select aria-label="Inference model" value={scope.model} onChange={event => setScope(previous => ({ ...previous, model: event.target.value }))}><option value="all">All 6 models</option>{INFERENCE_MODELS.map(model => <option key={model}>{model}</option>)}</select></label><label>Window<select aria-label="Inference time window" value={scope.hours} onChange={event => setScope(previous => ({ ...previous, hours: Number(event.target.value) as 1 | 6 }))}><option value={1}>Last 1 hour</option><option value={6}>Last 6 hours</option></select></label>{(scope.region !== 'all' || scope.model !== 'all' || scope.hours !== 6) && <button className="inference-reset" aria-label="Reset inference scope" onClick={() => setScope({ region: 'all', model: 'all', hours: 6 })}><RotateCcw size={13}/></button>}</div><div className="inference-metrics">{metrics.map(metric => <div key={metric.label}><metric.icon size={19}/><span><strong>{metric.value}<small>{metric.unit}</small></strong><em>{metric.label}</em></span></div>)}</div></div>
    <ChartCursorProvider><div className="inference-grid">
      <Panel title={current(data.rack).title} subtitle="Each cell is one supplied rack/slot device. Utilization uses a fixed 0–100% scale; hatching is unavailable telemetry, not zero. Click or use arrows and Enter to inspect a device." actions={edit(data.rack)} className="inference-rack-panel"><div className="inference-rack-chart">{visual(data.rack)}</div></Panel>
      <InferenceLatencyPair histogram={{ ...data.histogram, widget: current(data.histogram) }} queue={{ ...data.queue, widget: current(data.queue) }} times={data.times} edit={panel => panels.actionsFor(panel.widget, panel.result)}/>
      <Panel title={current(data.routing).title} subtitle="Every row records original region→model→outcome requests/s. The two sets of links share the same records, so every intermediate node conserves flow. Retry attempts are excluded. Snapshot rates follow the selected region/model, independent of historical view width." actions={edit(data.routing)} className="inference-routing-panel"><div className="inference-routing-chart">{visual(data.routing)}</div></Panel>
      <Panel title={current(data.scatter).title} subtitle="One point represents a paired model throughput and TTFT observation at the same five-minute timestamp. Both axes are logarithmic. Zero, negative and missing pairs are disclosed and excluded. Selecting a model in this legend filters only the scatter." actions={edit(data.scatter)} className="inference-scatter-panel"><div className="inference-scatter-chart">{visual(data.scatter)}</div></Panel>
      <Panel title={current(data.workloadPanel).title} subtitle="Exact snapshot evidence for the selected region and model. GPU capacity counts include devices with unavailable telemetry; reporting counts exclude them. Per-model p95 is estimated from each model’s histogram, while the fleet p95 is estimated separately from pooled compatible histograms." actions={edit(data.workloadPanel)} className="inference-workloads-panel"><div className="inference-workloads-chart">{visual(data.workloadPanel)}</div></Panel>
    </div></ChartCursorProvider>
    <footer className="inference-footer"><span>{data.summary.gpus} devices · {data.workloads.length} models · {data.times.length} timestamps per series</span><span>Snapshot metrics retain their scope when a chart is zoomed · no live provider connection</span></footer>
  </main>;
}
