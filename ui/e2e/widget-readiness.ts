export interface WidgetReadinessSnapshot {
  busy: boolean;
  loading: boolean;
  text: string;
  values: number;
  buckets: number;
  series: number;
  operationalCharts: number;
  gauges: number;
}

export function widgetRendered(widget: { type: string; pluginId?: string; title: string }, snapshot: WidgetReadinessSnapshot) {
  if (snapshot.busy || snapshot.loading || /Waiting to load|Querying data source|No data in this time range/.test(snapshot.text) || snapshot.text.trim().length <= widget.title.length) return false;
  if (widget.type === "stat") return snapshot.values === 1;
  if (widget.pluginId === "distribution-heatmap") return snapshot.buckets > 20;
  if (widget.pluginId === "stacked-timeseries" || widget.pluginId === "directional-traffic") return snapshot.series >= 2;
  if (["connection-map", "pipeline-topology", "incident-calendar"].includes(widget.pluginId ?? "")) return snapshot.operationalCharts === 1;
  if (widget.pluginId === "threshold-gauge") return snapshot.gauges === 1;
  return true;
}
