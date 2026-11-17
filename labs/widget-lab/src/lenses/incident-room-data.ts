import type { QueryResult, Widget } from '@insights/schema';
import { alignedTelemetryConfig, traceWaterfallConfig, dependencyConfig } from '../charts/incident/incident-model';

export const INCIDENT_START = Date.UTC(2026, 9, 31, 9, 30);
export const INCIDENT_END = INCIDENT_START + 30 * 60_000;
export const INCIDENT_SERVICES = [
  { id: 'checkout-api', status: 'Degraded', tone: 'red', factor: 1 },
  { id: 'payment-svc', status: 'Errors', tone: 'red', factor: .64 },
  { id: 'order-svc', status: 'Elevated', tone: 'amber', factor: .42 },
  { id: 'inventory-svc', status: 'Healthy', tone: 'green', factor: .58 },
  { id: 'user-svc', status: 'Healthy', tone: 'green', factor: .35 },
  { id: 'catalog-svc', status: 'Healthy', tone: 'green', factor: .76 },
] as const;
export type IncidentService = typeof INCIDENT_SERVICES[number]['id'];
export const INCIDENT_EVENTS = [
  { id: 'deploy-checkout', label: 'checkout-api v1.14.3', start: INCIDENT_START + 3*60_000, kind: 'deployment' as const },
  { id: 'deploy-payment', label: 'payment-svc v2.8.1', start: INCIDENT_START + 10*60_000 + 12_000, kind: 'deployment' as const },
  { id: 'incident-2048', label: 'INC-2048 · SEV 2', start: INCIDENT_START + 11*60_000, end: INCIDENT_START + 23*60_000, kind: 'incident' as const },
];

export function incidentSamples(service: IncidentService) {
  const source = INCIDENT_SERVICES.find(item => item.id === service)!;
  return Array.from({ length: 181 }, (_,i) => {
    const timestamp = INCIDENT_START + i*10_000, minute = i/6;
    const impact = minute >= 11 && minute <= 23 ? Math.sin((minute - 11)/12*Math.PI) : 0;
    const missing = i >= 156;
    const rate = (1400 + 600*Math.sin(i*.019) + 120*Math.sin(i*.47) + 55*Math.sin(i*1.71) + impact*1000)*source.factor;
    const requests = missing ? null : Math.round(Math.max(40,rate)*10);
    const severity = source.tone === 'green' ? .015 : source.tone === 'amber' ? .17 : service === 'payment-svc' ? 1.45 : 1;
    const errors = requests === null ? null : Math.round(requests*(.005 + Math.max(0,impact)*.20*severity));
    const p95 = missing ? null : Math.round(85 + source.factor*65 + severity*(impact*1100 + (i%11===0 ? impact*480 : 0)) + Math.abs(Math.sin(i*.52))*50);
    return { timestamp, requests, errors, rate: requests === null ? null : requests/10, errorRatio: requests && errors !== null ? errors/requests*100 : requests === 0 ? null : null, p95 };
  });
}

export function summarizeIncident(samples: ReturnType<typeof incidentSamples>, window = { start: INCIDENT_START, end: INCIDENT_END }) {
  const rows = samples.filter(sample => sample.timestamp >= window.start && sample.timestamp <= window.end);
  const observed = rows.filter(sample => sample.requests !== null);
  const requests = observed.reduce((sum,sample) => sum + sample.requests!,0), errors = observed.reduce((sum,sample) => sum + sample.errors!,0);
  return { requests, errors, errorRatio: requests ? errors/requests*100 : null, observed: observed.length, missing: rows.length-observed.length, lastObserved: observed.at(-1)?.timestamp ?? null };
}

const base = (id:string,title:string,pluginId:string,kind:'metrics'|'records'='records'):Widget => ({ id,title,type:'plugin',pluginId,dataKind:kind,providerId:'incident-fixture',query:'synthetic.incident_2048',unit:'',layout:{x:0,y:0,w:6,h:5},options:{showTooltip:true,showLegend:true,decimals:1} });

export function incidentTelemetryPanel(service: IncidentService) {
  const samples = incidentSamples(service);
  const widget: Widget = {...base('incident-telemetry','Service telemetry','aligned-telemetry','metrics'),config:alignedTelemetryConfig.parse({tracks:[
    { name:'Request rate',label:'Request rate',unit:'req/s',color:'#11cde5',maximum:6000,decimals:0 },
    { name:'Latency p95',label:'Latency · p95',unit:'ms',color:'#a289f5',maximum:2400,decimals:0 },
    { name:'Error ratio',label:'Error ratio',unit:'%',color:'#ff7568',maximum:35,decimals:2 },
  ],laneHeight:68,events:INCIDENT_EVENTS})};
  const result:QueryResult = {series:[
    {name:'Request rate',labels:{service,unit:'req/s',cadence:'10s',fixture:'synthetic'},points:samples.map(s=>({timestamp:s.timestamp,value:s.rate}))},
    {name:'Latency p95',labels:{service,unit:'ms',statistic:'synthetic per-bucket p95; not averaged across instances'},points:samples.map(s=>({timestamp:s.timestamp,value:s.p95}))},
    {name:'Error ratio',labels:{service,unit:'%',denominator:'observed requests in the same 10-second bucket'},points:samples.map(s=>({timestamp:s.timestamp,value:s.errorRatio}))},
  ]};
  return { widget,result,samples,summary:summarizeIncident(samples) };
}

const TRACE_ID = '7f3a2e0c9b4d1a77';
const spans: [string,string|null,string,string,number,number,string][] = [
  ['root',null,'checkout-api','POST /v1/checkout',0,1892,'ERROR'],
  ['validate','root','checkout-api','validate-cart',15,74,'OK'],
  ['get-user','root','user-svc','get-user',86,48,'OK'],
  ['price','root','catalog-svc','price-items',142,76,'OK'],
  ['payment','root','payment-svc','process-payment',283,1203,'ERROR'],
  ['create','payment','payment-svc','create-payment',294,35,'OK'],
  ['authorize','payment','payment-svc','payments.authorize',420,482,'ERROR'],
  ['fraud','payment','fraud-svc','fraud-check',410,220,'OK'],
  ['bank','payment','bank-gateway','bank.authorize',680,612,'ERROR'],
  ['retry','payment','payment-svc','retry-backoff',1302,170,'OK'],
  ['record','root','order-svc','record-order',1490,86,'OK'],
  ['emit','root','checkout-api','emit-events',1588,54,'OK'],
  ['stock','root','inventory-svc','reserve-inventory',1180,312,'OK'],
  ['response','root','checkout-api','build-response',1644,148,'ERROR'],
];
export function incidentTracePanel() {
  const result:QueryResult = {records:{columns:[{key:'spanId',type:'string'},{key:'parentId',type:'string'},{key:'service',type:'string'},{key:'operation',type:'string'},{key:'startMs',type:'number',unit:'ms'},{key:'durationMs',type:'number',unit:'ms'},{key:'status',type:'string'},{key:'traceId',type:'string'}],rows:spans.map(span=>[...span,TRACE_ID])}};
  return {widget:{...base('incident-trace','Trace waterfall','trace-waterfall'),unit:'ms',config:traceWaterfallConfig.parse({rowHeight:23})},result};
}
export function incidentDependencyPanel() {
  const result:QueryResult = {records:{columns:[{key:'source',type:'string'},{key:'target',type:'string'},{key:'latencyMs',type:'number',unit:'ms'},{key:'requests',type:'number'},{key:'errors',type:'number'}],rows:[
    ['web','checkout-api',12,120000,9200],['checkout-api','user-svc',28,120000,18],['checkout-api','order-svc',28,84000,1200],
    ['checkout-api','catalog-svc',18,120000,12],['checkout-api','payment-svc',482,92000,12800],['checkout-api','inventory-svc',22,84000,32],
    ['payment-svc','fraud-svc',95,92000,46],['payment-svc','bank-gateway',612,88000,12320],
  ]}};
  return {widget:{...base('incident-dependencies','Service dependencies','service-dependency'),config:dependencyConfig.parse({})},result};
}
export const INCIDENT_EVIDENCE = [
  {id:'deploy',time:INCIDENT_START+612_000,kind:'Deployment',service:'payment-svc',message:'Deployed payment-svc v2.8.1 · temporal context',detail:'Revision 8a1b2c3; deployment does not establish cause.',span:null},
  {id:'retry',time:INCIDENT_START+737_000,kind:'Retry',service:'checkout-api',message:'Observed retry attempts increased from 3 to 5',detail:'Retry observations belong to sampled request 7f3a2e0c9b4d1a77.',span:'authorize'},
  {id:'timeout',time:INCIDENT_START+843_000,kind:'Timeout',service:'payment-svc',message:'bank-gateway response · 612ms against 500ms policy',detail:'Configured fixture timeout policy: 500ms; observed child span: 612ms.',span:'bank'},
  {id:'recover',time:INCIDENT_START+1166_000,kind:'Recovery',service:'payment-svc',message:'EU West failure ratio declined in observed requests',detail:'Regional recovery observation; other regions remained degraded.',span:null},
  {id:'sample',time:INCIDENT_START+1390_000,kind:'Observation',service:'checkout-api',message:'Error ratio returned near the pre-incident baseline',detail:'Recovery applies to observed buckets. Telemetry is unavailable after 09:56 UTC.',span:null},
];
export const INCIDENT_REGIONS = [
  {id:'us-east',name:'US East',longitude:-77,latitude:39,errors:4200,traffic:12400},
  {id:'eu-west',name:'EU West',longitude:8,latitude:50,errors:2800,traffic:8100},
  {id:'ap-southeast',name:'AP Southeast',longitude:151,latitude:-34,errors:2000,traffic:6200},
  {id:'other',name:'Other',longitude:-47,latitude:-15,errors:1000,traffic:3200},
];
