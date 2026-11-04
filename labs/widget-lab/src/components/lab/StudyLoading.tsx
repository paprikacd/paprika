import theme from '@insights/gamma/gamma-theme.module.css';
import { ChartLoading, type ChartLoadingVariant } from './ChartLoading';
import { useGammaScope } from './appearance';

/** Suspense fallback uses the same loading language as the widget query host, in the resolved appearance. */
export function StudyLoading({ label, variant = 'line' }: { label: string; variant?: ChartLoadingVariant }) {
  const scope = useGammaScope();
  return <div className={`${theme.scope} obs-app study-pending`} {...scope}>
    <ChartLoading label={label} variant={variant} height={340}/>
  </div>;
}
