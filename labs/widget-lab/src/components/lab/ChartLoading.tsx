import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useLabMotion } from './motion';
import './ChartLoading.css';

export type ChartLoadingVariant = 'line' | 'bars' | 'table' | 'matrix' | 'topology';

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const isDocumentHidden = () => document.hidden;
const serverHidden = () => true;

function useLoadingMotion() {
  const { reduced } = useLabMotion();
  const hidden = useSyncExternalStore(subscribeVisibility, isDocumentHidden, serverHidden);
  const ref = useRef<HTMLDivElement>(null);
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A non-supporting browser still gets the static, labelled loading state.
    if (typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(candidate => candidate.target === element);
      if (active && entry) setInViewport(entry.isIntersecting);
    });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, []);

  const motion = reduced ? 'reduced' : hidden || !inViewport ? 'paused' : 'auto';
  return { ref, motion };
}

/** Presentation-only outlines. They never enter the data or inspection pipeline. */
function Placeholder({ variant }: { variant: ChartLoadingVariant }) {
  if (variant === 'table') {
    return <div className="chart-loading-table">{Array.from({ length: 5 }, (_, row) => <div key={row}>
      <i/><i/><i/><i/>
    </div>)}</div>;
  }
  if (variant === 'matrix') {
    return <div className="chart-loading-matrix">{Array.from({ length: 48 }, (_, cell) => <i key={cell}/>)}</div>;
  }
  if (variant === 'bars') {
    return <div className="chart-loading-bars">{[46, 70, 58, 84, 66, 92, 74, 55].map((height, index) =>
      <i key={index} style={{ '--placeholder-height': `${height}%` } as CSSProperties}/>,
    )}</div>;
  }
  if (variant === 'topology') {
    return <svg className="chart-loading-topology" viewBox="0 0 560 180" preserveAspectRatio="xMidYMid meet" focusable="false">
      <path d="M80 90H240M280 90H480M280 90V38M280 90V142"/>
      <rect x="30" y="68" width="100" height="44" rx="5"/>
      <rect x="230" y="68" width="100" height="44" rx="5"/>
      <rect x="430" y="68" width="100" height="44" rx="5"/>
      <rect x="240" y="12" width="80" height="36" rx="5"/>
      <rect x="240" y="132" width="80" height="36" rx="5"/>
    </svg>;
  }
  return <svg className="chart-loading-line" viewBox="0 0 560 180" preserveAspectRatio="none" focusable="false">
    <path className="chart-loading-area" d="M0 130C40 130 40 105 80 105S120 118 160 118S200 75 240 75S280 88 320 88S360 52 400 52S440 66 480 66S520 36 560 36V180H0Z"/>
    <path d="M0 130C40 130 40 105 80 105S120 118 160 118S200 75 240 75S280 88 320 88S360 52 400 52S440 66 480 66S520 36 560 36"/>
  </svg>;
}

/** Reserve the final plot footprint while a real request or code chunk is pending. */
export function ChartLoading({ variant = 'line', label = 'Loading chart', height = 240, className = '' }: {
  variant?: ChartLoadingVariant;
  label?: string;
  height?: number | 'fill';
  className?: string;
}) {
  const { ref, motion } = useLoadingMotion();
  const reservedHeight = height === 'fill' ? '100%' : Number.isFinite(height) ? Math.max(120, height) : 240;
  return <div ref={ref} className={`chart-loading ${className}`} data-variant={variant} data-motion={motion}
    style={{ height: reservedHeight }} role="status" aria-live="polite" aria-atomic="true">
    <div className="chart-loading-visual" aria-hidden="true">
      <div className="chart-loading-axis"><i/><i/><i/></div>
      <div className="chart-loading-plot"><Placeholder variant={variant}/></div>
      <div className="chart-loading-ticks"><i/><i/><i/><i/></div>
    </div>
    <span className="chart-loading-label"><i aria-hidden="true"/>{label}</span>
  </div>;
}

/** Position inside the existing plot host; retained data remains visible and usable. */
export function ChartRefreshing({ label = 'Refreshing chart', className = '' }: { label?: string; className?: string }) {
  const { ref, motion } = useLoadingMotion();
  return <div ref={ref} className={`chart-refreshing ${className}`} data-motion={motion} role="status" aria-live="polite" aria-atomic="true">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5"/>
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"/>
    </svg>
    <span>{label}</span>
  </div>;
}
