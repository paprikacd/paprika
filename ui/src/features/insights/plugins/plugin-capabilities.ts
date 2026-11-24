/**
 * Document capabilities of the bundled plugins: which document features a plugin's renderer supports. Built-in widget
 * types are decided where they are used; this table covers plugins only.
 *
 * This file imports nothing, so the Zod schema, the canvas and the editors can read it without an import cycle.
 * widget-plugin-list.test.ts writes it into docs/design/insights/widget-plugins.json, and the Go lint reads that file.
 * Change an entry here, then regenerate the list with UPDATE_WIDGET_PLUGINS=1.
 */
export interface PluginDocumentCapabilities {
  /** Event markers can be drawn on the plot. */
  annotations?: true;
  /** The tooltip view controls apply to the plugin. */
  tooltipView?: true;
  /** A deliberate activation can set selectionBindings. */
  selection?: true;
}

export const PLUGIN_DOCUMENT_CAPABILITIES = Object.freeze({
  "stacked-timeseries": { annotations: true },
  "directional-traffic": { annotations: true },
  "geo-heatmap": { tooltipView: true, selection: true },
  "connection-map": { selection: true },
  "pie": { selection: true },
  "record-list": { selection: true },
  "record-matrix": { selection: true },
  "record-table": { selection: true },
  "record-treemap": { selection: true },
  "records-bar": { selection: true },
  "records-line": { selection: true },
  "status-history": { selection: true },
  // Every bundled plugin is listed, so a new one has to decide. These support none of the three.
  "distribution-heatmap": {},
  "incident-calendar": {},
  "kubernetes-placement": {},
  "kubernetes-resource-bars": {},
  "kubernetes-resource-trend": {},
  "kubernetes-throttle-matrix": {},
  "pipeline-topology": {},
  "slo-summary": {},
  "small-multiples": {},
  "status-grid": {},
  "threshold-gauge": {},
  "uptime-calendar": {},
  "uptime-timeline": {},
} satisfies Record<string, PluginDocumentCapabilities>);

/** True when the plugin id is listed in the table with the capability set. Unknown ids support nothing. */
export function pluginSupports(id: string | undefined, capability: keyof PluginDocumentCapabilities): boolean {
  if (id === undefined || !Object.prototype.hasOwnProperty.call(PLUGIN_DOCUMENT_CAPABILITIES, id)) return false;
  const entry: PluginDocumentCapabilities = PLUGIN_DOCUMENT_CAPABILITIES[id as keyof typeof PLUGIN_DOCUMENT_CAPABILITIES];
  return entry[capability] === true;
}
