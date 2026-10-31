import { registerDefaultWidgetPlugins } from '../vendor/paprika/ui/src/features/insights/plugins/threshold-gauge';

/** Explicit bundle owner: availability never depends on visiting another route first. */
export function registerLabCharts() {
  registerDefaultWidgetPlugins();
}
