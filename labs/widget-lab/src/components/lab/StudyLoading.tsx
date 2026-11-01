import theme from '@insights/gamma/gamma-theme.module.css';
import { ChartLoading, type ChartLoadingVariant } from './ChartLoading';
import { labMotionStyle, useLabMotion } from './motion';

/** Suspense fallback uses the same loading language as the widget query host. */
export function StudyLoading({ label, variant = 'line' }: { label: string; variant?: ChartLoadingVariant }) {
  const { reduced } = useLabMotion();
  return <div className={`${theme.scope} obs-app study-pending`} data-insights-theme="dark"
    data-motion={reduced ? 'reduced' : 'auto'} style={labMotionStyle(reduced)}>
    <ChartLoading label={label} variant={variant} height={340}/>
  </div>;
}
