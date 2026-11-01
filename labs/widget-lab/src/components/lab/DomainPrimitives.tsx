import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Panel } from './StudyPrimitives';
import { WidgetVisualization } from '../../vendor/paprika/ui/src/features/insights/charts';
import type { QueryResult, Widget } from '../../vendor/paprika/ui/src/features/insights/schema';
import type { DrilldownContext } from '../../vendor/paprika/ui/src/features/insights/drilldown';
import type { EditLensWidget } from '../../lenses/LensStudio';
import { useLabMotion } from './motion';
import './DomainPrimitives.css';
import { useDashboardPanels } from './DashboardWorkbench';
export { useInspection } from '../../charts/shared/inspection';
export { DomainInspector } from './DomainInspector';

export const CHART_COLORS = {
  cyan: 'var(--gamma-chart-1)', violet: 'var(--gamma-chart-2)', mint: 'var(--gamma-success)',
  amber: 'var(--gamma-warning)', orange: 'var(--gamma-accent)', red: 'var(--gamma-danger)',
  muted: 'var(--gamma-muted)', blue: 'var(--gamma-chart-6)',
} as const;
export type DomainPanel = { widget: Widget; result: QueryResult; caption?: string };

export function usePlotWidth(ref: RefObject<HTMLElement | null>, fallback = 640) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(Math.max(220, Math.round(node.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function DomainHeader({ title, eyebrow = 'PAPRIKA', children }: { title: string; eyebrow?: string; children?: ReactNode }) {
  return <header className="domain-heading"><div className="domain-heading-title"><p>{eyebrow}</p><h1>{title}</h1><span>Concept · synthetic data</span></div><div className="domain-controls">{children}</div></header>;
}

export function MetricStrip({ items }: { items: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'cyan' | 'violet' | 'green' | 'amber' | 'red' }[] }) {
  const { reduced } = useLabMotion();
  return <div className="domain-metrics" data-motion={reduced ? 'reduced' : 'auto'}>{items.map(item => <section key={item.label} data-tone={item.tone ?? 'cyan'}><span>{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</section>)}</div>;
}

/** Shared panel host retains presentation overrides while controlled selection follows its lens. */
export function DomainChartPanel({ panel, onEdit, className = '', height, caption, selection, onContextChange }: {
  panel: DomainPanel; onEdit?: EditLensWidget; className?: string; height?: number; caption?: string;
  selection?: Widget['config']; onContextChange?: (context: DrilldownContext) => void;
}) {
  const { reduced } = useLabMotion();
  const panels = useDashboardPanels(onEdit);
  const widget = panels.current(panel.widget, selection);
  return <Panel title={widget.title} className={`domain-panel ${reduced ? 'domain-motion-reduced' : 'domain-motion-auto'} ${className}`} subtitle={caption ?? panel.caption} actions={panels.actions(panel, selection)}>
    <div className="domain-chart-host" style={height ? { minHeight: height } : undefined}><WidgetVisualization widget={widget} result={panel.result} onContextChange={onContextChange}/></div>
  </Panel>;
}

export function DetailValues({ items }: { items: [string, ReactNode][] }) {
  return <dl className="domain-detail-values">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
