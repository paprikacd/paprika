import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { area, line } from 'd3-shape';
import { Info } from 'lucide-react';
import { useLabMotion } from './motion';
import './StudyPrimitives.css';

export type Tone = 'cyan' | 'violet' | 'green' | 'amber' | 'red';
const toneColors: Record<Tone, string> = {
  cyan: 'var(--gamma-chart-1)', violet: 'var(--gamma-chart-2)',
  green: 'var(--gamma-success)', amber: 'var(--gamma-warning)', red: 'var(--gamma-danger)',
};

export function Sparkline({ values, color = 'var(--gamma-chart-1)', height = 36, label, domain, filled = true }: {
  values: ReadonlyArray<number | null>; color?: string; height?: number; label?: string; domain?: readonly [number, number]; filled?: boolean;
}) {
  const id = useId();
  const width = 150;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const low = filled ? Math.min(0, ...finite) : domain?.[0] ?? Math.min(0, ...finite);
  const high = filled ? Math.max(1, ...finite) : domain?.[1] ?? Math.max(1, ...finite);
  const x = (_: number | null, index: number) => 2 + index / Math.max(1, values.length - 1) * (width - 4);
  const y = (v: number | null) => 3 + (high - (v ?? 0)) / (high - low || 1) * (height - 6);
  const defined = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const stroke = line<number | null>().defined(defined).x(x).y(y)(values);
  const fill = area<number | null>().defined(defined).x(x).y0(y(0)).y1(y)(values);
  return <svg className="lab-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".17" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
    {filled && fill && <path d={fill} fill={`url(#${id})`} />}
    {stroke && <path d={stroke} fill="none" stroke={color} strokeWidth="1.35" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
  </svg>;
}

export function MetricCard({ label, value, unit, detail, trend, trendDomain, trendFill = true, trendLabel, tone = 'cyan', icon, children, className = '' }: {
  label: string; value: ReactNode; unit?: string; detail?: ReactNode;
  trend?: ReadonlyArray<number | null>; trendDomain?: readonly [number, number]; trendFill?: boolean; trendLabel?: string; tone?: Tone; icon?: ReactNode; children?: ReactNode; className?: string;
}) {
  const color = toneColors[tone];
  const card = useRef<HTMLElement>(null);
  const displayedValue = useRef<HTMLDivElement>(null);
  const previousValue = useRef<string | undefined>(undefined);
  const { reduced } = useLabMotion();
  useEffect(() => {
    const surface = card.current;
    const valueElement = displayedValue.current;
    const currentValue = valueElement?.textContent ?? '';
    const changed = previousValue.current !== undefined && previousValue.current !== currentValue;
    previousValue.current = currentValue;
    if (!changed || reduced || !surface || !valueElement || typeof surface.animate !== 'function') return;
    const computed = getComputedStyle(surface);
    const configuredDuration = Number.parseFloat(computed.getPropertyValue('--gamma-duration-slow'));
    const duration = Number.isFinite(configuredDuration) ? configuredDuration : 360;
    if (duration <= 0) return;
    const emphasis = computed.getPropertyValue('--metric-color').trim();
    const ink = computed.getPropertyValue('--gamma-ink').trim();
    const border = computed.getPropertyValue('--gamma-border').trim();
    const surfaceAnimation = surface.animate([
      { borderColor: emphasis, boxShadow: 'inset 0 0 0 100px color-mix(in srgb, var(--metric-color) 7%, transparent)' },
      { borderColor: border, boxShadow: 'inset 0 0 0 100px transparent' },
    ], { duration, easing: 'cubic-bezier(.2, 0, .2, 1)' });
    const valueAnimation = valueElement.animate([{ color: emphasis }, { color: ink }], { duration, easing: 'ease-out' });
    return () => { surfaceAnimation.cancel(); valueAnimation.cancel(); };
  }, [value, unit, reduced]);
  return <section ref={card} className={`lab-kpi ${className}`} style={{ '--metric-color': color } as CSSProperties} data-has-trend={Boolean(trend)} data-has-icon={Boolean(icon)} aria-label={label}>
    {icon && <span className="lab-kpi-icon" aria-hidden="true">{icon}</span>}
    <div className="lab-kpi-content"><span className="lab-kpi-label">{label}</span><div ref={displayedValue} className="lab-kpi-value">{value}{unit && <span>{unit}</span>}</div></div>
    {trend && <div className="lab-kpi-trend"><Sparkline values={trend} color={color} domain={trendDomain} filled={trendFill} label={trendLabel} /></div>}
    {detail && <div className="lab-kpi-detail">{detail}</div>}
    {children && <div className="lab-kpi-extra">{children}</div>}
  </section>;
}

function PanelInfo({ title, children }: { title: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target) && details.current) details.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <details className="lab-panel-info" ref={details} onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
  }} onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; trigger.current?.focus();
    }
  }}><summary ref={trigger} aria-label={`About ${title}`} aria-controls={id}><Info size={13} /></summary><div id={id} className="lab-panel-info-body" role="note">{children}</div></details>;
}

export function Panel({ title, subtitle, caption, actions, children, className = '' }: {
  title: string; subtitle?: ReactNode; caption?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  const id = useId();
  return <section className={`lab-panel ${className}`} aria-labelledby={id}>
    <header className="lab-panel-heading"><div className="lab-panel-title"><div className="lab-panel-title-row"><h2 id={id}>{title}</h2>{subtitle && <PanelInfo title={title}>{subtitle}</PanelInfo>}</div>{caption && <p className="lab-panel-caption">{caption}</p>}</div>{actions && <div className="lab-panel-actions">{actions}</div>}</header>
    {children}
  </section>;
}

export function StatusBadge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'muted'; children: ReactNode }) {
  return <span className={`lab-status lab-status-${tone}`}><i aria-hidden="true" />{children}</span>;
}

export function EmptyNotice({ children }: { children: ReactNode }) {
  return <div className="lab-empty" role="status">{children}</div>;
}
