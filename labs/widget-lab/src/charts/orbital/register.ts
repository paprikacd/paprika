import { getWidgetDefinition, registerWidgetPlugin } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { OrbitalContactTimeline, OrbitalGroundTrack, OrbitalLinkBudget, OrbitalSkyplot } from './OrbitalCharts';
import { budgetTerms, contactTimelineConfig, groundPoints, groundTrackConfig, linkBudgetConfig, skyPoints, skyplotConfig, summarizePasses } from './model';
import { OrbitalPassProfile } from './OrbitalPassProfile';
import { passProfileConfig, passProfilePoints, profilePasses } from './pass-profile-model';

export function registerOrbitalCharts() {
  const definitions = [
    { id:'orbital-ground-track',label:'Orbital ground tracks',description:'Time-tagged synthetic trajectories, dateline splitting and an independent bounded geographic camera',render:OrbitalGroundTrack,schema:groundTrackConfig,validate:groundPoints,fields:[{key:'showLabels',label:'Show station labels',kind:'boolean' as const},{key:'showEclipse',label:'Distinguish eclipse segments',kind:'boolean' as const},{key:'showGraticule',label:'Show geographic graticule',kind:'boolean' as const},{key:'showPassPicker',label:'Show pass picker',kind:'boolean' as const}]},
    { id:'orbital-skyplot',label:'Polar satellite skyplot',description:'Azimuth clockwise from north, zenith at centre and exact timed contact observations',render:OrbitalSkyplot,schema:skyplotConfig,validate:(frame:Parameters<typeof skyPoints>[0])=>summarizePasses(skyPoints(frame)),fields:[{key:'showMask',label:'Show illustrative horizon mask',kind:'boolean' as const},{key:'showTimeLabels',label:'Show selected-track time labels',kind:'boolean' as const},{key:'showPassPicker',label:'Show pass picker',kind:'boolean' as const}]},
    { id:'orbital-contact-timeline',label:'Contact windows and signals',description:'Predicted access intervals with gap-aware margin and throughput on one reversible UTC window',render:OrbitalContactTimeline,schema:contactTimelineConfig,validate:(frame:Parameters<typeof skyPoints>[0])=>summarizePasses(skyPoints(frame)),fields:[{key:'showSignals',label:'Show aligned signal tracks',kind:'boolean' as const},{key:'showUncertainty',label:'Show supplied margin uncertainty',kind:'boolean' as const},{key:'showPassPicker',label:'Show pass picker',kind:'boolean' as const}]},
    { id:'orbital-link-budget',label:'Relative link margin waterfall',description:'Additive relative dB gains and losses with exact cumulative accounting',render:OrbitalLinkBudget,schema:linkBudgetConfig,validate:budgetTerms,fields:[{key:'showValues',label:'Show exact contribution values',kind:'boolean' as const}]},
  ];
  for (const d of definitions) if (!getWidgetDefinition('plugin',d.id)) registerWidgetPlugin({ id:d.id,label:d.label,description:d.description,dataKind:'records',render:d.render,defaultConfig:d.schema.parse({}),parseConfig:config=>d.schema.parse(config??{}),configFields:d.fields,styleControls:['tooltips','legend'],layout:{mode:'intrinsic',minWidth:280,minHeight:220},validateInput:(result,config)=>{d.schema.parse(config??{});d.validate(result.records);} });
  if (!getWidgetDefinition('plugin', 'orbital-pass-profile')) registerWidgetPlugin({
    id: 'orbital-pass-profile', label: 'Contact qualification profile', description: 'Aligned elevation, margin and throughput with gap-aware threshold-qualified duration and capacity',
    dataKind: 'records', render: OrbitalPassProfile, defaultConfig: passProfileConfig.parse({}), parseConfig: config => passProfileConfig.parse(config ?? {}),
    validateInput: (result, config) => { profilePasses(passProfilePoints(result.records, config)); },
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 400 }, styleControls: ['tooltips', 'legend'],
    configFields: [
      { key: 'minimumElevation', label: 'Minimum elevation (°)', kind: 'number', min: 0, max: 90, step: 1, help: 'Planning threshold; intersections are interpolated between supplied samples.' },
      { key: 'minimumMargin', label: 'Minimum link margin (dB)', kind: 'number', min: -50, max: 100, step: .5 },
      { key: 'maxGapSeconds', label: 'Maximum sample gap (seconds)', kind: 'number', min: 1, max: 3600, step: 1, help: 'Longer intervals remain unknown and cannot contribute to complete duration or volume.' },
      { key: 'showThresholds', label: 'Show planning threshold rules', kind: 'boolean' },
      { key: 'showEligibleWindows', label: 'Highlight qualifying intervals', kind: 'boolean' },
      { key: 'showSampleMarkers', label: 'Show supplied sample marks', kind: 'boolean' },
      { key: 'showPassPicker', label: 'Show contact picker', kind: 'boolean' },
      { key: 'idField', label: 'Observation identity field', kind: 'text', binding: { types: ['string'], role: 'Unique identity per observation' } },
      { key: 'passField', label: 'Contact identity field', kind: 'text', binding: { types: ['string'], role: 'Stable contact identity' } },
      { key: 'satelliteField', label: 'Satellite label field', kind: 'text', binding: { types: ['string'], role: 'Satellite name, consistent within each contact' } },
      { key: 'stationField', label: 'Station label field', kind: 'text', binding: { types: ['string'], role: 'Station name, consistent within each contact' } },
      { key: 'timestampField', label: 'UTC sample timestamp field', kind: 'text', binding: { types: ['number'], unit: 'ms', role: 'UTC epoch milliseconds' } },
      { key: 'elevationField', label: 'Elevation field', kind: 'text', binding: { types: ['number'], unit: '°', role: 'Station-relative elevation from 0° to 90°' } },
      { key: 'marginField', label: 'Link margin field', kind: 'text', binding: { types: ['number'], unit: 'dB', role: 'Nullable relative link margin' } },
      { key: 'throughputField', label: 'Throughput field', kind: 'text', binding: { types: ['number'], unit: 'Mbps', role: 'Nullable nonnegative transfer rate' } },
    ],
  });
}
