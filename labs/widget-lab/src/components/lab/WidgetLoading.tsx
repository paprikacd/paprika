import type { ReactNode } from 'react';
import type { Widget } from '../../renderer-extensions/schema';
import { WidgetLoadingProvider, type WidgetLoadingPresentation } from '../../renderer-extensions/widget-loading';
import { ChartLoading, ChartRefreshing, type ChartLoadingVariant } from './ChartLoading';

/** A visual hint only. The registry and normalized result retain all data ownership. */
export function chartLoadingVariant(widget: Widget): ChartLoadingVariant {
  const family = widget.pluginId ?? widget.type;
  if (/heatmap|matrix|placement|wafer|history/.test(family)) return 'matrix';
  if (/topology|network|connection|sankey|movement/.test(family)) return 'topology';
  if (/table|traces|waterfall|trace|profile|flame/.test(family)) return 'table';
  if (/bar|histogram|contribution|evidence|gauge/.test(family)) return 'bars';
  return 'line';
}

const renderLoading: WidgetLoadingPresentation = ({ widget, phase }) => phase === 'initial'
  ? <ChartLoading variant={chartLoadingVariant(widget)} label={`Loading ${widget.title}`} height="fill"/>
  : <ChartRefreshing label={`Refreshing ${widget.title}`}/>;

export function LabWidgetLoadingProvider({ children }: { children: ReactNode }) {
  return <WidgetLoadingProvider render={renderLoading}>{children}</WidgetLoadingProvider>;
}
