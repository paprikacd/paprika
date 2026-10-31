import type { QueryResult, RecordFrame, Widget } from '../../vendor/paprika/ui/src/features/insights/schema';
import { cohortConfig, controlConfig, countConfig, distributionConfig, flowConfig, intervalConfig, sampleGroups, quantile } from '../../charts/analytics/data';
export type AnalyticsPanel = { widget: Widget; result: QueryResult };
const day = 86400000;
export const ANALYTICS_AS_OF = Date.UTC(2026, 9, 31, 0);
export const recordWidget = (id: string, title: string, pluginId: string, unit = '', config: Widget['config'] = {}): Widget => ({ id, title, type:'plugin', pluginId, dataKind:'records', providerId:'analytics-fixture', query:'synthetic.analytics.' + id, unit, config, layout:{x:0,y:0,w:6,h:5}, options:{showTooltip:true,showLegend:true,decimals:2} });
export const frame = (columns: RecordFrame['columns'], rows: RecordFrame['rows']): QueryResult => ({records:{columns,rows}});
const col = (key: string, type: 'string' | 'number' | 'boolean' = 'number', unit?: string) => ({key,label:key,type,unit});
export const COHORT_NAMES = Array.from({length:12},(_,i)=>new Date(Date.UTC(2026,7,10) + i * 7 * day).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'2-digit'}));
const sizes = [980,1120,1260,1380,1240,1420,1310,1180,1040,960,820,610];
export function buildCohorts(includeGap = false): QueryResult {
  return frame([col('cohort','string'),col('week'),col('size'),col('retained'),col('observed','boolean')],COHORT_NAMES.flatMap((cohort,i)=>Array.from({length:11},(_,week)=>{
    const observed = week <= Math.floor((ANALYTICS_AS_OF - (Date.UTC(2026,7,10) + i * 7 * day)) / (7 * day));
    const fraction = week === 0 ? 1 : Math.max(.12, .78 * Math.exp(-.225 * week) + .16 + Math.sin(i * .63) * .025);
    const retained = !observed || includeGap && i === 5 && week === 3 ? null : Math.round(sizes[i] * fraction);
    return [cohort,week,sizes[i],retained,observed];
  })));
}
function partition(total: number, weights: number[]) { const parts = weights.map(w=>Math.floor(total*w)); parts[parts.length-1] += total-parts.reduce((a,b)=>a+b,0); return parts; }
export function buildJourney(cohort = 'Sep 14', gaps = false) {
  const index = Math.max(0,COHORT_NAMES.indexOf(cohort)), size = sizes[index], matrix = buildCohorts(gaps);
  const stageCounts = [size,...[.78,.57,.38,.29].map(f=>Math.floor(size*f))];
  const sources = ['Data source','Template','Explore'], sourceCounts = partition(size,[.53,.3,.17]);
  const remainingOutcomes = partition(size,[.57,.27,.16]); let remainingTotal = size;
  const paths = sources.flatMap((stage,i)=>{ const outcomes = i === sources.length-1 ? [...remainingOutcomes] : partition(sourceCounts[i],remainingOutcomes.map(count=>count/remainingTotal)); remainingTotal-=sourceCounts[i]; outcomes.forEach((count,j)=>remainingOutcomes[j]-=count); return outcomes.map((count,j)=>['Start',stage,['Dashboard','Exit','Return later'][j],count]); });
  const observedW4 = matrix.records!.rows.filter(r=>r[1]===4 && r[4]===true && r[3]!==null), eligible = observedW4.reduce((n,r)=>n+(r[2] as number),0), retained = observedW4.reduce((n,r)=>n+(r[3] as number),0);
  return {
    summary:{total:sizes.reduce((a,b)=>a+b,0),eligible,retained,retention:retained/eligible*100,size,activated:stageCounts[2]},
    matrix:{widget:recordWidget('journey-cohorts','Workspace retention by cohort','cohort-matrix','%',cohortConfig.parse({selectedCohort:cohort})),result:matrix},
    funnel:{widget:recordWidget('journey-funnel','Activation funnel · selected cohort','conversion-funnel','workspaces',countConfig.parse({})),result:frame([col('label','string'),col('count')],['Created workspace','Connected data','Built dashboard','Invited teammate','Weekly active'].map((label,i)=>[label,stageCounts[i]]))},
    flow:{widget:recordWidget('journey-paths','First-session paths','stage-flow','sessions',flowConfig.parse({sourceTitle:'Initial cohort',stageTitle:'First action',outcomeTitle:'Session outcome'})),result:frame([col('source','string'),col('stage','string'),col('outcome','string'),col('count')],paths)},
  };
}
/** Deterministic Gaussian quantiles: fixtures are synthetic observations, never measured factory output. */
function normalQuantile(p: number) { const t = Math.sqrt(-2 * Math.log(Math.min(p,1-p))); const z=t-(2.515517+.802853*t+.010328*t*t)/(1+1.432788*t+.189269*t*t+.001308*t*t*t); return p<.5?-z:z; }
export const MACHINES = ['M01','M02','M03','M04','M05','M06'];
export function buildFactory(scenario: 'stable' | 'drift' | 'gaps' = 'drift') {
  const observations = Array.from({length:45},(_,i)=>{ const drift = scenario==='stable' ? 0 : i>=27 && i<=33 ? .029*Math.sin((i-26)/8*Math.PI) : 0; const mean=25+.006*Math.sin(i*.83)+.004*Math.sin(i*2.13)+drift; return [i+1, scenario==='gaps' && i>=18&&i<=22?null:mean,scenario==='gaps' && i>=18&&i<=22?null:.006+Math.abs(Math.sin(i*.9))*.008+(i===31?.012:0)] as RecordFrame['rows'][number]; });
  // Six complete authored populations fit the host's 1,000-row record contract.
  const samplesPerMachine = 160, tailStart = Math.floor(samplesPerMachine * .87);
  const sampleRows = MACHINES.flatMap((machine,i)=>Array.from({length:samplesPerMachine},(_,j)=>[machine,25+[-.001,.001,-.006,.012,0,-.009][i]+normalQuantile((j+.5)/samplesPerMachine)*(.007+i%3*.001)+(i===3&&scenario!=='stable'?(j>=tailStart?.018:0):0)]));
  const sampleResult=frame([col('group','string'),col('value','number','mm')],sampleRows), all=sampleRows.map(r=>r[1] as number), outside=all.filter(v=>v<24.95||v>25.05).length;
  const control:AnalyticsPanel={widget:recordWidget('factory-control','Diameter process control · subgroup means','statistical-control','mm',controlConfig.parse({})),result:frame([col('sample'),col('mean','number','mm'),col('range','number','mm')],observations)};
  const histogram:AnalyticsPanel={widget:recordWidget('factory-histogram','Part dimension distribution','sample-distribution','mm',distributionConfig.parse({mode:'histogram',lowerSpec:24.95,upperSpec:25.05})),result:sampleResult};
  const violin:AnalyticsPanel={widget:recordWidget('factory-variation','Variation by machine','sample-distribution','mm',distributionConfig.parse({mode:'violin'})),result:sampleResult};
  const pareto:AnalyticsPanel={widget:recordWidget('factory-defects','Defects by cause','pareto-bars','defects',countConfig.parse({})),result:frame([col('label','string'),col('count')],[['Burr',210],['Diameter',120],['Surface',55],['Alignment',28],['Porosity',18]])};
  return {control,histogram,violin,pareto,summary:{inspected:all.length,outside,yield:(1-outside/all.length)*100,breaches:observations.filter(r=>r[1]!==null&&((r[1] as number)<24.976||(r[1] as number)>25.024)).length},groups:sampleGroups(sampleResult.records!),observations};
}
export const TREATMENTS = ['Guided setup','Template first','Quick connect'];
export function buildExperiments(population: 'All workspaces' | 'Pro workspaces' = 'All workspaces') {
  const multiplier=population==='All workspaces'?1:1.3, n=population==='All workspaces'?10650:2840;
  const draws = TREATMENTS.flatMap((treatment,i)=>Array.from({length:301},(_,j)=>[treatment,[2.1,.8,-.6][i]*multiplier+normalQuantile((j+.5)/301)*[.8,.76,.77][i]*(population==='All workspaces'?1:1.35)]));
  const distributions=frame([col('group','string'),col('value','number','pp')],draws), groups=sampleGroups(distributions.records!);
  const segments = population === 'All workspaces' ? [['Overall',1],['Free',.67],['Pro',1.33]] : [['Overall',1],['Small',.67],['Large',1.33]];
  const estimates = groups.flatMap(g=>segments.map(([segment,factor])=>{ const f=factor as number; const values=g.values.map(v=>v*f).sort((a,b)=>a-b); return [g.label+' · '+segment,g.label,quantile(values,.5),quantile(values,.025),quantile(values,.975),quantile(values,.1),quantile(values,.9),segment==='Overall'?n:Math.floor(n*(segment==='Free'||segment==='Small'?.7:.3))]; }));
  const order = population === 'All workspaces' ? ['Overall','Free','Pro'] : ['Overall','Small','Large']; estimates.sort((a,b)=>order.indexOf(String(a[0]).split(' · ')[1])-order.indexOf(String(b[0]).split(' · ')[1]));
  const forest:AnalyticsPanel={widget:recordWidget('experiment-effects','Treatment effect vs control','interval-estimates','pp',intervalConfig.parse({})),result:frame([col('label','string'),col('group','string'),col('estimate','number','pp'),col('lower','number','pp'),col('upper','number','pp'),col('innerLower','number','pp'),col('innerUpper','number','pp'),col('samples')],estimates)};
  const ridge:AnalyticsPanel={widget:recordWidget('experiment-densities','Effect distributions','sample-distribution','pp',distributionConfig.parse({mode:'ridge'})),result:distributions};
  const times:AnalyticsPanel={widget:{id:'experiment-history',title:'Evidence over time',type:'timeseries',providerId:'analytics-fixture',query:'synthetic.analytics.experiment-history',unit:'pp',layout:{x:0,y:0,w:6,h:5},options:{showTooltip:true,showLegend:true,showGrid:true,gridX:true,timeAxis:'calendar',curve:'linear',lineWidth:1.6,decimals:3,display:'line',showZeroLine:true,referenceLines:[{value:0,label:'Zero effect',style:'dashed'}]}},result:{series:TREATMENTS.map((treatment,i)=>({name:treatment,labels:{population,fixture:'Synthetic posterior snapshots',timezone:'UTC'},points:Array.from({length:22},(_,j)=>({timestamp:Date.UTC(2026,9,10+j),value:[2.1,.8,-.6][i]*multiplier*(1-Math.exp(-j/5)) + Math.sin(j*.74+i)*.24*(1-j/25)}))}))}};
  const coverage=['Control',...TREATMENTS].map((arm,i)=>{ const assigned=Math.ceil(n/(.88+i*.02)),pending=Math.floor(assigned*(.1-i*.02)); return {arm,assigned,observed:n,pending,missing:assigned-n-pending}; });
  const guardrails = TREATMENTS.map((treatment,i)=>({treatment,metrics:[{label:'Error rate',change:[.02,-.01,.04][i],unit:'pp',bound:.5},{label:'p95 setup time',change:[6,11,22][i],unit:'s',bound:20},{label:'Support contacts',change:[1.7,.4,-.2][i],unit:'/1k',bound:1}]}));
  return {forest,ridge,times,groups,n,population,coverage,guardrails};
}
