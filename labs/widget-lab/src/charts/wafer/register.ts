import { getWidgetDefinition, registerWidgetPlugin, type WidgetPlugin } from '@insights/widget-registry';
import { chamberRows, waferChamberConfig, waferLineageConfig, waferMapConfig, waferRows, waferSignatureConfig, waferTransect, waferTransectConfig, waferTransectRows, waferYieldConfig } from './model';
import { WaferDieMap } from './WaferMap';
import { WaferChamberDistribution, WaferProcessLineage, WaferSignature, WaferYieldWaterfall } from './WaferCharts';
import { WaferTransect } from './WaferTransect';
import { checkedInput } from '../../renderer-extensions/input-issues';

export function registerWaferCharts() {
  const definitions: WidgetPlugin[] = [
    { id: 'wafer-transect', label: 'Physical wafer cross-section', description: 'Leakage across a physical row or column, retaining unmeasured and excluded positions and gaps between supplied dies.', dataKind: 'records', render: WaferTransect,
      defaultConfig: waferTransectConfig.parse({}), parseConfig: c => waferTransectConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { const c = waferTransectConfig.parse(config ?? {}); waferTransect(waferTransectRows(result.records, c), c); }),
      configFields: [
        { key: 'xField', label: 'Physical X field', kind: 'text', binding: { types: ['number'], unit: 'mm', role: 'Horizontal die-centre position; must agree with column × pitch.' } },
        { key: 'yField', label: 'Physical Y field', kind: 'text', binding: { types: ['number'], unit: 'mm', role: 'Vertical die-centre position; must agree with row × pitch.' } },
        { key: 'valueField', label: 'Leakage field', kind: 'text', binding: { types: ['number'], unit: 'nA', role: 'Observed leakage in nanoamps. Missing measurements stay null.' } },
        { key: 'axis', label: 'Section direction', kind: 'select', options: [{ value: 'row', label: 'Row · physical X axis' }, { value: 'column', label: 'Column · physical Y axis' }] },
        { key: 'followSelection', label: 'Follow the selected die', kind: 'boolean', help: 'Use the selected die’s row or column. With no selected die, use the configured index.' },
        { key: 'index', label: 'Row or column index', kind: 'number', min: -10000, max: 10000, step: 1, help: 'Used when following is disabled or no die is selected. Index is the physical grid identity, not a position in the data array.' },
        { key: 'scale', label: 'Leakage scale', kind: 'select', options: [{ value: 'log', label: 'Logarithmic · positive values' }, { value: 'linear', label: 'Linear · includes measured zero' }] },
        { key: 'showConnections', label: 'Connect adjacent measured dies', kind: 'boolean', help: 'Missing values and unsupplied grid slots always break the trace.' },
        { key: 'showGrid', label: 'Physical reference grid', kind: 'boolean' },
        { key: 'showReference', label: 'Show leakage reference', kind: 'boolean' },
        { key: 'referenceValue', label: 'Leakage reference · nA', kind: 'number', min: .001, max: 10000, step: .1, help: 'A display reference. Supplied final test bins remain unchanged.' },
      ], styleControls: ['tooltips', 'legend'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 350 } },
    { id: 'wafer-die-map', label: 'Physical wafer die map', description: 'Discrete die identities and physical millimetre coordinates with bounded camera and exact inspection.', dataKind: 'records', render: WaferDieMap,
      defaultConfig: waferMapConfig.parse({}), parseConfig: c => waferMapConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { waferMapConfig.parse(config ?? {}); waferRows(result.records); }),
      configFields: [
        { key: 'colorMode', label: 'Colour encoding', kind: 'select', options: [{ value: 'bin', label: 'Final test bin' }, { value: 'leakage', label: 'Measured leakage · log colour' }] },
        { key: 'filter', label: 'Visible dies', kind: 'select', help: 'Presentation filter; wafer totals retain their complete denominator.', options: [{ value: 'all', label: 'All positions' }, { value: 'failed', label: 'All failed' }, { value: 'pass', label: 'Passing' }, { value: 'leakage', label: 'Leakage failures' }, { value: 'timing', label: 'Timing failures' }, { value: 'open', label: 'Open failures' }, { value: 'untested', label: 'Untested' }, { value: 'excluded', label: 'Edge exclusions' }] },
        { key: 'showCoordinates', label: 'Physical coordinate axes', kind: 'boolean' }, { key: 'showGrid', label: 'Coordinate grid', kind: 'boolean' },
        { key: 'cellGap', label: 'Painted die gap', kind: 'number', min: 0, max: .35, step: .01 },
      ], styleControls: ['tooltips', 'legend'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 380 } },
    { id: 'wafer-signature', label: 'Wafer spatial defect signature', description: 'Angular and radial failure bins from a single physical wafer, with explicit tested denominators.', dataKind: 'records', render: WaferSignature,
      defaultConfig: waferSignatureConfig.parse({}), parseConfig: c => waferSignatureConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { waferSignatureConfig.parse(config ?? {}); waferRows(result.records); }),
      configFields: [
        { key: 'metric', label: 'Spatial encoding', kind: 'select', options: [{ value: 'rate', label: 'Failure rate within bin' }, { value: 'count', label: 'Failed die count' }] },
        { key: 'defect', label: 'Failure bin', kind: 'select', options: [{ value: 'all', label: 'All failures' }, { value: 'leakage', label: 'Leakage' }, { value: 'timing', label: 'Timing' }, { value: 'open', label: 'Open' }] },
        { key: 'angularBins', label: 'Angular sectors', kind: 'number', min: 8, max: 24, step: 4, help: 'Supported equal partitions: 8, 12, 16, 20 or 24 sectors.' },
        { key: 'showValues', label: 'Angular guide values', kind: 'boolean' },
      ], styleControls: ['tooltips', 'legend'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 280 } },
    { id: 'wafer-yield-waterfall', label: 'Wafer yield accounting', description: 'Exclusive failure bins reconcile tested and passing counts; unknowns never become failures.', dataKind: 'records', render: WaferYieldWaterfall,
      defaultConfig: waferYieldConfig.parse({}), parseConfig: c => waferYieldConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { waferYieldConfig.parse(config ?? {}); waferRows(result.records); }),
      configFields: [{ key: 'showValues', label: 'Exact bar values', kind: 'boolean' }], styleControls: ['tooltips'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 255 } },
    { id: 'wafer-chamber-distribution', label: 'Chamber leakage distributions', description: 'Explicit lot-level quartiles and 1.5×IQR whiskers, with known missing and outlier populations.', dataKind: 'records', render: WaferChamberDistribution,
      defaultConfig: waferChamberConfig.parse({}), parseConfig: c => waferChamberConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { const c = waferChamberConfig.parse(config ?? {}); chamberRows(result.records, c.scale); }),
      configFields: [{ key: 'scale', label: 'Leakage axis', kind: 'select', options: [{ value: 'log', label: 'Logarithmic' }, { value: 'linear', label: 'Linear from zero' }] }, { key: 'showOutliers', label: 'Bounded outlier marks', kind: 'boolean' }, { key: 'specification', label: 'Specification reference · nA', kind: 'number', min: .001, max: 10000, step: .1 }],
      styleControls: ['tooltips', 'legend'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 260 } },
    { id: 'wafer-process-lineage', label: 'Die process history', description: 'Supplied stage timestamps and measurements for one selected die, with distinct physical units.', dataKind: 'records', render: WaferProcessLineage,
      defaultConfig: waferLineageConfig.parse({}), parseConfig: c => waferLineageConfig.parse(c ?? {}), validateInput: (result, config) => checkedInput(() => { waferLineageConfig.parse(config ?? {}); waferRows(result.records); }),
      configFields: [{ key: 'showMeasurements', label: 'Stage measurement table', kind: 'boolean' }], styleControls: ['tooltips'], sizing: { mode: 'intrinsic', minWidth: 280, minHeight: 230 } },
  ];
  for (const definition of definitions) if (!getWidgetDefinition('plugin', definition.id)) registerWidgetPlugin(definition);
}
