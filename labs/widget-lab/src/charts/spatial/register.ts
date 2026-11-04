import {getWidgetDefinition,registerWidgetPlugin} from '@insights/widget-registry';
import {mapConfig,intervalConfig,spectrumConfig,iqConfig,roseConfig,curtainConfig} from './model';
import {RouteMap,CoastalVectorMap} from './Maps';
import {ETAWindows,DwellBoxplot,DirectionalRose,IQConstellation} from './DistributionCharts';
import {SpectrumAnalyzer,DepthCurtain} from './FieldCharts';
export function registerSpatialCharts(){
 const definitions=[
 {id:'route-map',label:'Geographic shipment routes',description:'Supplied route coordinates with bounded camera and linked shipment inspection',render:RouteMap,schema:mapConfig,fields:[{key:'showLabels',label:'Show destination labels',kind:'boolean' as const}]},
 {id:'eta-windows',label:'Arrival windows',description:'P10–P90 estimates, medians and promised timestamps on one UTC axis',render:ETAWindows,schema:intervalConfig,fields:[{key:'showValues',label:'Show selected delay probability',kind:'boolean' as const}]},
 {id:'dwell-boxplot',label:'Dwell box plots',description:'Ordered quartiles, whiskers, supplied outliers and population counts',render:DwellBoxplot,schema:intervalConfig,fields:[{key:'showValues',label:'Show median and population',kind:'boolean' as const}]},
 {id:'spectrum-analyzer',label:'Spectrum analyzer',description:'Dense spectrogram and spectral lines sharing one frequency viewport',render:SpectrumAnalyzer,schema:spectrumConfig,fields:[{key:'showPeakHold',label:'Show peak-hold spectrum',kind:'boolean' as const},{key:'showGrid',label:'Show raster grid',kind:'boolean' as const}]},
 {id:'iq-constellation',label:'I/Q constellation',description:'Complex samples with ideal-symbol positions and calculated RMS error',render:IQConstellation,schema:iqConfig,fields:[{key:'showIdeal',label:'Show ideal symbol crosses',kind:'boolean' as const},{key:'showGrid',label:'Show coordinate grid',kind:'boolean' as const}]},
 {id:'coastal-vector-map',label:'Coastal vector field',description:'Geographic vector samples and buoy observations in one bounded camera',render:CoastalVectorMap,schema:mapConfig,fields:[{key:'showLabels',label:'Show buoy labels',kind:'boolean' as const},{key:'showVectors',label:'Show current vectors',kind:'boolean' as const}]},
 {id:'directional-rose',label:'Directional rose',description:'Direction and speed-bin counts with area-proportional polar sectors',render:DirectionalRose,schema:roseConfig,fields:[{key:'showValues',label:'Show frequency guide labels',kind:'boolean' as const}]},
 {id:'depth-curtain',label:'Depth–time curtain',description:'Exact temperature observations by UTC time and increasing depth',render:DepthCurtain,schema:curtainConfig,fields:[{key:'showGrid',label:'Show acquisition cell boundaries',kind:'boolean' as const}]}
 ];
 for(const d of definitions)if(!getWidgetDefinition('plugin',d.id))registerWidgetPlugin({id:d.id,label:d.label,description:d.description,render:d.render,dataKind:'records',parseConfig:c=>d.schema.parse(c??{}),defaultConfig:d.schema.parse({}),configFields:d.fields,styleControls:['tooltips','legend']});
}
