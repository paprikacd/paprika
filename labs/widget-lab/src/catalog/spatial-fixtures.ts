import type { CatalogFeature, CatalogPreset } from './chart-fixtures';
import type { QueryResult, Widget } from '@insights/schema';
import { coastalFixtures, logisticsFixtures, spectrumFixtures } from '../lenses/spatial/fixtures';

export type SpatialCatalogId = 'route-map'|'eta-windows'|'dwell-boxplot'|'spectrum-analyzer'|'iq-constellation'|'coastal-vector-map'|'directional-rose'|'depth-curtain';
const standard = ['ready','gaps','empty','error'] as const;
const complete = ['ready','empty','error'] as const;
export const spatialChartCatalog: readonly (Omit<CatalogFeature,'id'>&{id:SpatialCatalogId})[] = [
  {id:'route-map',label:'Geographic shipment routes',group:'Logistics Control Tower',lensHref:'#logistics-control',question:'Where are shipments routed, and which arrival estimates need attention?',contract:'Supplied WGS84 port coordinates and optional waypoints determine routes in a fitted projection. Paths are explicitly illustrative; selection does not change the map camera or source population.',inspect:'Ordinary wheel zoom, drag or arrow-key pan, zoom buttons, Home reset and an exact shipment picker. Select a route to link its ETA and evidence.',presets:complete,owner:'RouteMap / shipments + shared geographic camera'},
  {id:'eta-windows',label:'ETA windows and promises',group:'Logistics Control Tower',lensHref:'#logistics-control',question:'Which scenario arrival intervals fall after their delivery promise?',contract:'P10 ≤ median ≤ P90 is validated. All intervals and promise markers share a real UTC timestamp scale. Delay probabilities are supplied scenario estimates.',inspect:'Inspect or pin a shipment to see exact bounds, promise slack and delay probability. Selection links with the route map.',presets:complete,owner:'ETAWindows / shipments'},
  {id:'dwell-boxplot',label:'Port dwell distributions',group:'Logistics Control Tower',lensHref:'#logistics-control',question:'How do elapsed dwell distributions vary across ports?',contract:'Supplied min, quartiles, median and max must be ordered and nonnegative. Separate supplied outliers and explicit sample counts remain inspectable.',inspect:'Select a port using pointer or keyboard to inspect all quantiles and its sample population.',presets:complete,owner:'DwellBoxplot / dwellRows'},
  {id:'spectrum-analyzer',label:'Spectrogram and aligned spectrum',group:'Spectrum Observatory',lensHref:'#spectrum-observatory',question:'Where did frequency-specific power change during the capture?',contract:'The canvas paints exact frequency-time observations; the spectrum uses the same frequency scale and gutters. Missing acquisitions remain distinct from weak signal. Peak hold uses observed bins only.',inspect:'Drag a frequency band, use numeric bounds, undo or reset. Arrow keys inspect exact cells; Enter pins the time slice and associated spectrum.',presets:standard,owner:'SpectrumAnalyzer / fieldCells + frequency window'},
  {id:'iq-constellation',label:'I/Q constellation',group:'Spectrum Observatory',lensHref:'#spectrum-observatory',question:'How far are measured complex samples from their ideal symbols?',contract:'Every finite I/Q sample retains supplied ideal coordinates. RMS EVM is square root of summed error energy divided by summed ideal-symbol energy, expressed as a percent.',inspect:'Select the nearest sample, navigate with arrow keys or enter an exact sample number. Inspect I/Q, magnitude, phase and the ideal symbol.',presets:complete,owner:'IQConstellation / iqRows + rmsEvm'},
  {id:'coastal-vector-map',label:'Coastal vector field',group:'Coastal Observatory',lensHref:'#coastal-observatory',question:'How do the supplied current vectors vary around the scenario basin?',contract:'Eastward and northward components are both observed or both unknown. Coordinates and geometry share a fitted projection. Basin, bathymetry and currents are synthetic, not geophysical measurements.',inspect:'Wheel zoom, bounded pan, keyboard and button controls. Pick a buoy to update the linked rose, depth and tidal observations without resetting the camera.',presets:standard,owner:'CoastalVectorMap / buoyRows + shared geographic camera'},
  {id:'directional-rose',label:'Current direction rose',group:'Coastal Observatory',lensHref:'#coastal-observatory',question:'Which directions and speed bins account for the current sample population?',contract:'Angles describe flow toward: north is 0°, east 90°. The squared radius grows with cumulative count, so sector area represents population. Counts are nonnegative integers.',inspect:'Select a directional speed segment to inspect its exact count and share of the complete population.',presets:complete,owner:'DirectionalRose / roseRows + polar geometry'},
  {id:'depth-curtain',label:'Depth–time temperature curtain',group:'Coastal Observatory',lensHref:'#coastal-observatory',question:'How does the temperature profile change with depth and time?',contract:'Depth increases downward. Exact time-depth cells retain null acquisitions, drawn with hatching; zero is still a numeric observation. Temperature uses a fixed 14–22 °C color domain.',inspect:'Arrow keys or pointer inspect exact time, depth and temperature. Pin a time to synchronize inspection with the tidal comparison.',presets:standard,owner:'DepthCurtain / fieldCells'},
];

export function isSpatialCatalogId(id:string):id is SpatialCatalogId {return spatialChartCatalog.some(f=>f.id===id);}
export function makeSpatialCatalogFixture(id:SpatialCatalogId,preset:CatalogPreset='ready'):{widget:Widget;result:QueryResult} {
  const feature=spatialChartCatalog.find(f=>f.id===id);
  if(!feature)throw new Error('Unknown spatial chart.');
  if(!feature.presets.includes(preset))throw new Error('Unsupported spatial fixture state.');
  let source:{widget:Widget;result:QueryResult};
  if(id==='route-map'||id==='eta-windows'||id==='dwell-boxplot'){
    const data=logisticsFixtures();source=id==='route-map'?data.map:id==='eta-windows'?data.eta:data.dwell;
  } else if(id==='spectrum-analyzer'||id==='iq-constellation'){
    const data=spectrumFixtures();source=id==='spectrum-analyzer'?data.analyzer:data.iq;
  } else {
    const data=coastalFixtures();source=id==='coastal-vector-map'?data.map:id==='directional-rose'?data.rose:data.curtain;
  }
  const result=structuredClone(source.result),widget=structuredClone(source.widget);widget.id='catalog-'+id;
  if(preset==='empty')result.records!.rows=[];
  if(preset==='gaps'){
    const rows=result.records!.rows;
    if(id==='coastal-vector-map')rows.forEach((row,i)=>{if(i%3===0){row[5]=null;row[6]=null;row[7]=null;row[8]=null;row[9]=null;}});
    else rows.forEach((row,i)=>{if(i%11<3)row[2]=null;});
  }
  return{widget,result};
}
