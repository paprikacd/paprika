import { getWidgetDefinition, registerWidgetPlugin } from '@insights/widget-registry';
import { operationalRecordPluginEntries } from '@insights/plugins/operational-records';
import { registerDefaultWidgetPlugins } from '@insights/plugins/threshold-gauge';
import { ZoomableConnectionMap } from '../renderer-extensions/connection-map';

/**
 * Explicit bundle owner: availability never depends on visiting another route first.
 *
 * One registry, production's. The lab adds one renderer to it: the zoomable connection map, which keeps production's
 * entry (fields, defaults and style controls) and replaces only its render. It registers before production's defaults,
 * which skip any id already held, so the lab's map is the one the lab shows. Production's own defaults register every
 * other bundled renderer. tests/register-lab-charts.test.ts pins this order.
 */
export function registerLabCharts() {
  if (!getWidgetDefinition('plugin', 'connection-map')) {
    const entry = operationalRecordPluginEntries().find(candidate => candidate.id === 'connection-map');
    if (!entry) throw new Error('Production no longer bundles the connection-map renderer');
    registerWidgetPlugin({ ...entry, dataKind: 'records', render: ZoomableConnectionMap });
  }
  registerDefaultWidgetPlugins();
}
