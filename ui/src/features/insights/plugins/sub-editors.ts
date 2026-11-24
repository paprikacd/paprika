import type { WidgetConfigEditorLoader } from "../widget-registry";

// Plugin sub-editors load on first use, so their code and styles stay out of the first view. Registrations name them
// through configEditors; plugin-config-editor.tsx renders them.
export const seriesColorEditor: WidgetConfigEditorLoader = () =>
  import("./series-color-editor").then((module) => ({ default: module.SeriesColorEditor }));

export const metricAnnotationEditor: WidgetConfigEditorLoader = () =>
  import("./metric-annotation-editor").then((module) => ({ default: module.MetricAnnotationEditor }));

export const recordTableStyleEditor: WidgetConfigEditorLoader = () =>
  import("./record-table-style-editor").then((module) => ({ default: module.RecordTableStyleEditor }));
