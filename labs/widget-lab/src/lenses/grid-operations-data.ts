import type { QueryResult, RecordFrame, Widget } from '../renderer-extensions/schema';

export const GRID_DAY_START = Date.UTC(2026, 9, 31);
export const GRID_AS_OF = GRID_DAY_START + 16 * 3600000;
export const GRID_STEP = 300000;
export const BATTERY_CAPACITY_MWH = 800;
export type GridWindow = 'day' | 'recent';
export type GridScenario = 'peak' | 'balanced';
export type GridPanel = { widget: Widget; result: QueryResult; caption: string };
const round = (v: number, p = 2) => Number(v.toFixed(p));
export const GRID_LOCATIONS = [
  ['red-cliffs','Red Cliffs',142.19,-34.31], ['kerang','Kerang',143.92,-35.73], ['horsham','Horsham',142.20,-36.71], ['ararat','Ararat',142.93,-37.28], ['ballarat','Ballarat',143.85,-37.56], ['bendigo','Bendigo',144.28,-36.76], ['shepparton','Shepparton',145.40,-36.38], ['albury','Albury',146.92,-36.08], ['wodonga','Wodonga',146.89,-36.12], ['seymour','Seymour',145.13,-37.03], ['eastern','Eastern hub',145.60,-37.75], ['melbourne','Melbourne South',144.96,-37.81], ['geelong','Geelong',144.36,-38.15], ['terang','Terang',142.92,-38.24], ['mortlake','Mortlake',142.81,-38.08], ['morwell','Morwell',146.40,-38.23], ['traralgon','Traralgon',146.54,-38.20], ['bairnsdale','Bairnsdale',147.63,-37.83], ['latrobe','Latrobe',146.62,-38.32],
] as const;
const LINKS: [string,string,number,number][] = [['red-cliffs','kerang',422,700],['red-cliffs','horsham',288,500],['kerang','bendigo',346,600],['horsham','ararat',264,500],['ararat','ballarat',408,650],['ararat','terang',201,400],['terang','mortlake',182,350],['mortlake','geelong',257,500],['geelong','ballarat',369,650],['ballarat','bendigo',308,600],['bendigo','eastern',765,900],['shepparton','albury',785,800],['albury','wodonga',196,350],['wodonga','seymour',346,600],['shepparton','seymour',419,700],['seymour','eastern',492,700],['eastern','melbourne',613,800],['eastern','morwell',918,900],['morwell','traralgon',308,600],['traralgon','bairnsdale',261,500],['bairnsdale','latrobe',173,400]];

export function gridDay(scenario: GridScenario = 'peak') {
  let energy = 440;
  return Array.from({length:193}, (_,i) => {
    const hour = i / 12, timestamp = GRID_DAY_START + i * GRID_STEP;
    const solar = Math.max(0, Math.sin((hour - 5.5) / 13 * Math.PI)) * 1880;
    const wind = 644 + Math.sin(i * .035) * 166 + Math.sin(i * .43) * 28;
    const hydro = 802 + Math.sin(i * .018 + 2) * 124;
    const dispatchable = 2050 + Math.sin(i * .024) * 125 + (scenario === 'peak' ? 260 * Math.exp(-(((hour - 15.5) / 1.7) ** 2)) : 0);
    const battery = round(-48*Math.sin(i*.037) + 74*Math.exp(-(((hour-8.5)/1.3)**2)) - 62*Math.exp(-(((hour-13.8)/.85)**2)));
    if (i > 0) energy -= battery * 5 / 60;
    const generation = round(solar) + round(wind) + round(hydro) + round(dispatchable);
    const exportMW = round(122 + 30*Math.sin(i*.027));
    const demand = generation + battery - exportMW;
    return {timestamp, solar:round(solar),wind:round(wind),hydro:round(hydro),dispatchable:round(dispatchable),generation:round(generation),battery,exportMW:round(exportMW),demand:round(demand),energy:round(energy,6),frequency:round(50+.024*Math.sin(i*.83)-.012*Math.cos(i*.24),3),reserve:round(scenario === 'peak' ? 298+22*Math.sin(i*.03) : 526+30*Math.sin(i*.03))};
  });
}

export function gridForecast(scenario: GridScenario = 'peak') {
  const day=gridDay(scenario), latest=day.at(-1)!;
  return Array.from({length:289},(_,i)=>{
    const timestamp=GRID_DAY_START+i*GRID_STEP, forecast=i>=192, h=(i-192)/12;
    const median=forecast?round(latest.demand + (scenario==='peak'?820:430)*Math.sin(Math.min(1,h/8)*Math.PI) - h*26):null;
    const spread=forecast?100+Math.sqrt(h)*160:0;
    return {timestamp,observed:i<=192?(i>=123&&i<=127?null:day[i].demand):null,median,low68:median===null?null:round(median-spread),high68:median===null?null:round(median+spread),low95:median===null?null:round(median-spread*1.8),high95:median===null?null:round(median+spread*1.8)};
  });
}

export function gridNetwork(scenario: GridScenario): QueryResult {
  const columns: RecordFrame['columns'] = [
    {key:'kind',type:'string'},{key:'id',type:'string'},{key:'label',type:'string'},{key:'longitude',type:'number'},{key:'latitude',type:'number'},{key:'value',type:'number',unit:'MW'},{key:'voltage',type:'number',unit:'kV'},{key:'reserve',type:'number',unit:'MW'},{key:'status',type:'string'},{key:'source',type:'string'},{key:'target',type:'string'},{key:'capacity',type:'number',unit:'MW'},{key:'timestamp',type:'number',unit:'ms'}
  ];
  const multiplier=scenario==='peak'?1:.76;
  const rows: RecordFrame['rows'] = GRID_LOCATIONS.map(([id,label,longitude,latitude],i)=>['node',id,label,longitude,latitude,id==='latrobe'?null:id==='eastern'?round(184*multiplier):round((112+i*13+Math.sin(i)*26)*multiplier),id==='latrobe'?null:i%3===0?500:220,id==='latrobe'?null:id==='eastern'?26:30+i*3,id==='latrobe'?'Unknown':id==='eastern'&&scenario==='peak'?'Constrained':'Normal',null,null,null,GRID_AS_OF]);
  for(const [source,target,value,capacity] of LINKS) rows.push(['link',`${source}-${target}`,`${source} → ${target}`,null,null,round(value*multiplier),null,null,value*multiplier>=capacity?'Constrained':'Normal',source,target,capacity,GRID_AS_OF]);
  GRID_LOCATIONS.forEach(([id],j)=>{ for(let i=0;i<49;i++) rows.push(['observation',id,null,null,null,i===48?rows[j][5]:id==='latrobe'&&i>42?null:round((id==='eastern'?184:112+j*13)*(0.8+0.2*Math.sin(i*.14+j)+.05*Math.sin(i*.91))*multiplier),null,null,null,null,null,null,GRID_DAY_START+i*1200000]); });
  return {records:{columns,rows}};
}

const base=(id:string,title:string,unit:string,patch:Partial<Widget>={}):Widget=>({id,title,type:'timeseries',providerId:'grid-fixture',query:`synthetic.grid.${id}`,unit,layout:{x:0,y:0,w:6,h:5},color:'#11cee5',options:{timeAxis:'calendar',showGrid:true,gridX:true,showLegend:true,showTooltip:true,inspectorDensity:'compact',decimals:0,curve:'linear',lineWidth:1.4,fillStyle:'gradient',fillOpacity:.16,display:'area',showZeroLine:true},...patch});

export function buildGridOperations(scenario:GridScenario='peak',window:GridWindow='day') {
  const complete=gridDay(scenario), day=window==='recent'?complete.slice(-73):complete, forecast=gridForecast(scenario).filter(p=>window==='day'||p.timestamp>=GRID_AS_OF-6*3600000), latest=complete.at(-1)!;
  const series=(key: 'solar'|'wind'|'hydro'|'dispatchable'|'battery'|'demand',name:string)=>({name,labels:{fixture:'synthetic',interval:'5 minutes',timezone:'UTC'},points:day.map(point=>({timestamp:point.timestamp,value:point[key]}))});
  const map:GridPanel={widget:base('grid-network','Victoria / transmission overview','MW',{type:'plugin',dataKind:'records',pluginId:'grid-network-map',config:{showLabels:true,showFlows:true,maxNodes:40}}),result:gridNetwork(scenario),caption:'Approximate city coordinates · synthetic corridors and telemetry; not a utility network'};
  const mix:GridPanel={widget:base('grid-mix','Generation mix','MW',{type:'plugin',dataKind:'metrics',pluginId:'stacked-timeseries',config:{display:'area',maxSeries:4,maxPoints:240,legendDisplay:'compact',legendPosition:'bottom'}}),result:{series:[series('dispatchable','Dispatchable'),series('hydro','Hydro'),series('wind','Wind'),series('solar','Solar')]},caption:'Exclusive generation sources · five-minute observations · UTC'};
  const battery:GridPanel={widget:base('grid-battery','Battery charge / discharge','MW',{type:'plugin',dataKind:'metrics',pluginId:'stacked-timeseries',config:{display:'bar',maxSeries:2,maxPoints:240,legendDisplay:'compact',legendPosition:'bottom'},options:{timeAxis:'calendar',showGrid:true,showLegend:false,showTooltip:true,inspectorDensity:'compact',decimals:1,showZeroLine:true}}),result:{series:[{...series('battery','Discharge (+)'),points:day.map(p=>({timestamp:p.timestamp,value:Math.max(0,p.battery)}))},{...series('battery','Charge (−)'),points:day.map(p=>({timestamp:p.timestamp,value:Math.min(0,p.battery)}))}]},caption:'Discharge + / charge − · power at the grid connection'};
  const prediction:GridPanel={widget:base('grid-forecast','Demand / observed vs forecast','MW',{type:'plugin',dataKind:'records',pluginId:'forecast-bands',config:{show68:true,show95:true,showGrid:true}}),result:{records:{columns:[{key:'timestamp',type:'number',unit:'ms'},...(['observed','median','low68','high68','low95','high95'] as const).map(key=>({key,type:'number' as const,unit:'MW'}))],rows:forecast.map(p=>[p.timestamp,p.observed,p.median,p.low68,p.high68,p.low95,p.high95])}},caption:'Forecast issued 16:00 UTC · synthetic central prediction intervals, not guarantees'};
  const states:GridPanel={widget:base('grid-state','Asset × time state','',{type:'plugin',dataKind:'metrics',pluginId:'status-history',config:{maxSeries:10,maxPoints:64},options:{decimals:0,showTooltip:true,thresholds:[{value:0,color:'#20bb9c',label:'Normal'},{value:1,color:'#f9bf56',label:'Degraded'},{value:2,color:'#f56363',label:'Outage'}]}}),result:{series:GRID_LOCATIONS.filter((_,i)=>i%2===0).slice(0,10).map(([id,name],s)=>({name,labels:{asset:id,fixture:'synthetic',cadence:'15 minutes'},points:Array.from({length:65},(_,i)=>({timestamp:GRID_DAY_START+i*900000,value:(s===9&&i>=58)||(s===3&&i>=44&&i<51)?null:(i+s*7)%29<3?1:s===2&&i>=59&&scenario==='peak'?2:0})).filter(p=>window==='day'||p.timestamp>=GRID_AS_OF-6*3600000)}))},caption:'15-minute state observations · gaps are unknown, not healthy'};
  const events:GridPanel={widget:base('grid-events','Recent constraints / events','',{type:'plugin',dataKind:'records',pluginId:'record-table',config:{columns:['time','asset','type','limit','value'],density:'compact',showSearch:false,pageSize:6}}),result:{records:{columns:[{key:'time',label:'Time UTC',type:'string'},{key:'asset',label:'Asset / corridor',type:'string'},{key:'type',label:'Type',type:'string'},{key:'limit',label:'Limit',type:'string'},{key:'value',label:'Observed',type:'string'}],rows:scenario==='peak'?[['15:52','Eastern → Morwell','Thermal','900 MW','918 MW'],['15:41','Melbourne South','Voltage','220 kV','214 kV'],['14:37','Latrobe','Telemetry','—','Unknown'],['13:21','Shepparton → Albury','Thermal','800 MW','785 MW']]:[['15:52','Eastern → Morwell','Thermal','900 MW','697.68 MW'],['14:37','Latrobe','Telemetry','—','Unknown'],['13:21','Shepparton → Albury','Thermal','800 MW','596.6 MW']]}},caption:'Scenario evidence · no live controls or alerts'};
  return {day,complete,forecast,latest,panels:{map,mix,battery,prediction,states,events}};
}
