import { getWidgetDefinition, registerWidgetPlugin } from '@insights/widget-registry';
import { GridNetworkMap } from './GridNetworkMap';
import { ForecastBands } from './ForecastBands';
import { forecastBandConfig, gridNetworkConfig, forecastRecords } from './grid-model';
import { checkedInput } from '../../renderer-extensions/input-issues';

export function registerGridCharts() {
  if(!getWidgetDefinition('plugin','grid-network-map')) registerWidgetPlugin({id:'grid-network-map',label:'Geographic network',description:'Located nodes and directed capacity links, with a bounded map camera and exact inspection',dataKind:'records',render:GridNetworkMap,parseConfig:config=>gridNetworkConfig.parse(config??{}),defaultConfig:gridNetworkConfig.parse({}),styleControls:['legend','tooltips'],configFields:[{key:'showLabels',label:'Show location labels',kind:'boolean'},{key:'showFlows',label:'Show directed flows',kind:'boolean'},{key:'maxNodes',label:'Maximum nodes',kind:'number',min:1,max:100,step:1}]});
  if(!getWidgetDefinition('plugin','forecast-bands')) registerWidgetPlugin({id:'forecast-bands',label:'Observed / forecast intervals',description:'Observed and predicted values with nested 68% and 95% intervals and local time zoom',dataKind:'records',render:ForecastBands,sizing: { mode:'intrinsic'},validateInput: r => {
      const records = r.records;
      return records ? checkedInput(() => { forecastRecords(records); }) : [];
    },parseConfig:config=>forecastBandConfig.parse(config??{}),defaultConfig:forecastBandConfig.parse({}),styleControls:['unit','legend','tooltips'],configFields:[{key:'show68',label:'Show 68% interval',kind:'boolean'},{key:'show95',label:'Show 95% interval',kind:'boolean'},{key:'showGrid',label:'Show reference grid',kind:'boolean'},{key:'showCapacity',label:'Show available capacity',kind:'boolean'}]});
}
