import type { ReactNode } from 'react';
import { WidgetLoadingProvider, type WidgetLoadingPresentation } from '@insights/widget-loading';
import type { Widget } from '@insights/schema';
import { ChartLoading, ChartRefreshing, type ChartLoadingVariant } from '../components/lab/ChartLoading';

/** A visual hint only. The registry and normalized result retain all data ownership. */
export function chartLoadingVariant(widget: Widget): ChartLoadingVariant {
  const family = widget.pluginId ?? widget.type;
  if (/heatmap|matrix|placement|wafer|history/.test(family)) return 'matrix';
  if (/topology|network|connection|sankey|movement/.test(family)) return 'topology';
  if (/table|traces|waterfall|trace|profile|flame/.test(family)) return 'table';
  if (/bar|histogram|contribution|evidence|gauge/.test(family)) return 'bars';
  return 'line';
}

/** The lab's skeleton for production's loading slot. Production keeps the phase rules; this supplies only the look. */
const renderLoading: WidgetLoadingPresentation = ({ widget, phase }) => phase === 'initial'
  ? <ChartLoading variant={chartLoadingVariant(widget)} label={`Loading ${widget.title}`} height="fill"/>
  : <ChartRefreshing label={`Refreshing ${widget.title}`}/>;

export function LabWidgetLoadingProvider({ children }: { children: ReactNode }) {
  return <WidgetLoadingProvider render={renderLoading}>{children}</WidgetLoadingProvider>;
}
