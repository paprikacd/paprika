import { getWidgetDefinition } from '../vendor/paprika/ui/src/features/insights/widget-registry';
/** Legacy fallback; new compound renderers declare layout beside their definition. */
const intrinsicIds=new Set([
 'profile-flamegraph','sampled-flamechart','query-plan',
 'cohort-matrix','conversion-funnel','stage-flow','statistical-control','sample-distribution','interval-estimates','pareto-bars',
 'route-map','eta-windows','dwell-boxplot','spectrum-analyzer','iq-constellation','coastal-vector-map','directional-rose','depth-curtain',
 'adjacency-matrix','entity-neighbourhood','event-swimlanes','resource-gantt','resource-load','schedule-dependencies','ternary-composition','pareto-scatter','parallel-coordinates',
]);
export const hasIntrinsicChartLayout=(widget:{pluginId?:string})=>!!widget.pluginId&&(getWidgetDefinition('plugin',widget.pluginId)?.layout?.mode==='intrinsic'||intrinsicIds.has(widget.pluginId));
