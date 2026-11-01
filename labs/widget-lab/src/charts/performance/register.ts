import { getWidgetDefinition, registerWidgetPlugin } from '../../renderer-extensions/widget-registry';
import { PerformanceLatencyDensity } from './PerformanceDensity';
import { PerformanceTraceWaterfall } from './PerformanceTrace';
import { PerformanceDifferentialFlamegraph } from './PerformanceProfile';
import { PerformancePairedEvidence } from './PerformanceEvidence';
import { differentialProfile, differentialProfileConfig, pairedEvidenceConfig, performanceDensityConfig, performanceObservations, performanceTrace, performanceTraceConfig } from './model';

export function registerPerformanceCharts() {
  if (!getWidgetDefinition('plugin', 'performance-latency-density')) registerWidgetPlugin({ id: 'performance-latency-density', label: 'Build latency density', description: 'Observed request heatmap, empirical quantiles and before/after distributions with explicit denominators.', dataKind: 'records', render: PerformanceLatencyDensity, defaultConfig: performanceDensityConfig.parse({}), parseConfig: input => performanceDensityConfig.parse(input ?? {}), validateInput: (result, config) => { if (result.records) performanceObservations(result.records, config); }, layout: { mode: 'intrinsic', minWidth: 300 }, styleControls: ['tooltips'], configFields: [
    { key: 'latencyField', label: 'Latency field (ms)', kind: 'text' }, { key: 'timeField', label: 'Timestamp field (epoch ms)', kind: 'text' },
    { key: 'bins', label: 'Logarithmic latency bins', kind: 'number', min: 12, max: 36, step: 1 }, { key: 'timeBuckets', label: 'Time buckets', kind: 'number', min: 8, max: 36, step: 1 },
    { key: 'showQuantiles', label: 'Show p50, p95 and p99', kind: 'boolean' }, { key: 'build', label: 'Heatmap build', kind: 'select', options: [{ value: 'before', label: 'Baseline v2.8.1' }, { value: 'after', label: 'Candidate v2.8.2' }] },
  ] });
  if (!getWidgetDefinition('plugin', 'performance-trace-waterfall')) registerWidgetPlugin({ id: 'performance-trace-waterfall', label: 'Performance request waterfall', description: 'Nested request spans with exact offset zoom and explicit non-overlapping phase accounting.', dataKind: 'records', render: PerformanceTraceWaterfall, defaultConfig: performanceTraceConfig.parse({}), parseConfig: input => performanceTraceConfig.parse(input ?? {}), validateInput: result => { if (result.records) performanceTrace(result.records); }, layout: { mode: 'intrinsic', minWidth: 300 }, styleControls: ['tooltips'], configFields: [
    { key: 'showService', label: 'Show service labels on wide plots', kind: 'boolean' }, { key: 'rowHeight', label: 'Span row height', kind: 'number', min: 24, max: 40, step: 1 },
  ] });
  if (!getWidgetDefinition('plugin', 'performance-differential-flamegraph')) registerWidgetPlugin({ id: 'performance-differential-flamegraph', label: 'Paired CPU differential flamegraph', description: 'Canonical profile accounting compares CPU costs and request-normalized costs while retaining whole-profile denominators.', dataKind: 'records', render: PerformanceDifferentialFlamegraph, defaultConfig: differentialProfileConfig.parse({}), parseConfig: input => differentialProfileConfig.parse(input ?? {}), validateInput: result => { if (result.records) differentialProfile(result.records); }, layout: { mode: 'intrinsic', minWidth: 300 }, styleControls: ['tooltips'], configFields: [
    { key: 'widthBy', label: 'Frame width population', kind: 'select', options: [{ value: 'before', label: 'Baseline CPU cost' }, { value: 'after', label: 'Candidate CPU cost' }] }, { key: 'rowHeight', label: 'Stack row height', kind: 'number', min: 22, max: 36, step: 1 }, { key: 'showLabels', label: 'Show function labels', kind: 'boolean' },
  ] });
  if (!getWidgetDefinition('plugin', 'performance-paired-evidence')) registerWidgetPlugin({ id: 'performance-paired-evidence', label: 'Matched build evidence intervals', description: 'Paired request metrics show mean costs, uncertainty and within-pair difference intervals without causal claims.', dataKind: 'records', render: PerformancePairedEvidence, defaultConfig: pairedEvidenceConfig.parse({}), parseConfig: input => pairedEvidenceConfig.parse(input ?? {}), validateInput: result => { if (result.records) performanceObservations(result.records); }, layout: { mode: 'intrinsic', minWidth: 280 }, styleControls: ['tooltips'], configFields: [
    { key: 'showIntervals', label: 'Show 95% normal intervals', kind: 'boolean' }, { key: 'showRelativeChange', label: 'Show relative mean changes', kind: 'boolean' },
  ] });
}
