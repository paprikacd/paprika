import { registerDefaultWidgetPlugins } from '@insights/plugins/threshold-gauge';
import { registerRichMetricPlugins } from '../renderer-extensions/plugins/rich-metrics';
import { registerOperationalRecordPlugins } from '../renderer-extensions/plugins/operational-records';

/**
 * Explicit bundle owner: availability never depends on visiting another route first.
 *
 * Order matters. Production's defaults register an id only while it is empty, so
 * the lab's holding renderers register first: the rich-metric plots, and the
 * operational records, which carry the zoomable connection map. Reversing the
 * order silently gives the lab production's versions. tests/register-lab-charts.test.ts
 * pins the result.
 */
export function registerLabCharts() {
  registerRichMetricPlugins();
  registerOperationalRecordPlugins();
  registerDefaultWidgetPlugins();
}
