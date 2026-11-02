import type { QueryResult, RecordFrame, Widget } from '@insights/schema';
import type { MaterialCandidate, ScheduleTask, ThreatEvent } from '../../charts/exploration/model';

export interface ExplorationPanel { widget: Widget; result: QueryResult }
export const THREAT_START=Date.UTC(2026,9,31,9), THREAT_END=THREAT_START+7_200_000;
export const THREAT_GAP={start:THREAT_START+58*60_000,end:THREAT_START+68*60_000};
const entities:[string,string][]=[['api-01','Host'],['api-02','Host'],['build-03','Host'],['db-01','Host'],['web-01','Host'],['worker-01','Host'],['svc-ci','Account'],['user.ops','Account'],['user.dev','Account'],['svc-backup','Account'],['curl','Process'],['sshd','Process'],['python','Process'],['java','Process'],['pkg.repo','Domain'],['external.example','Domain'],['secret-store','Service'],['vault','Service']];
const links:[number,number,string][]=[[6,2,'Auth'],[6,1,'Auth'],[2,1,'Process'],[1,3,'Network'],[1,15,'Network'],[1,16,'Auth'],[1,11,'Process'],[2,14,'Network'],[7,1,'Auth'],[8,4,'Auth'],[4,0,'Network'],[0,3,'Network'],[9,3,'Network'],[5,12,'Process'],[12,17,'Auth'],[0,13,'Process'],[4,10,'Process'],[10,14,'Network'],[2,12,'Process'],[7,17,'Change'],[16,17,'Network']];
export const THREAT_EVENTS:ThreatEvent[]=links.flatMap(([source,target,action],l)=>Array.from({length:10+l%7},(_,i)=>{
  let minute=(i*9+l*4)%120;if(minute>=58&&minute<68)minute+=11;
  return {id:`EV-${String(l*30+i+1).padStart(4,'0')}`,timestamp:THREAT_START+minute*60_000+(l*7+i*11)%60*1000,source:entities[source][0],target:entities[target][0],sourceType:entities[source][1],targetType:entities[target][1],action,count:1+(i+l)%5,confidence:72+(i*3+l)%27,reviewed:(i+l)%3===0};
})).sort((a,b)=>a.timestamp-b.timestamp);
export function threatFrame(events=THREAT_EVENTS):RecordFrame{return {columns:[['id','Event','string'],['timestamp','Time (epoch ms)','number'],['source','Source','string'],['target','Target','string'],['sourceType','Source type','string'],['targetType','Target type','string'],['action','Action','string'],['count','Observed events','number'],['confidence','Confidence (%)','number'],['reviewed','Reviewed','boolean']].map(([key,label,type])=>({key,label,type:type as 'string'|'number'|'boolean'})),rows:events.map(e=>[e.id,e.timestamp,e.source,e.target,e.sourceType,e.targetType,e.action,e.count,e.confidence,e.reviewed])};}

const taskSource:[string,string,string,string,number,number,number,string[]][]=[
 ['WO-101','Housing prep','Assembly','A-01',8,32,100,[]],
 ['WO-102','Board assembly','Assembly','A-02',32,64,80,['WO-101']],
 ['WO-103','Sensor fabrication','Assembly','A-03',8,48,100,[]],
 ['WO-201','Chamber preparation','Test chambers','TC-01',50,62,100,[]],
 ['WO-208','Thermal cycle','Test chambers','TC-02',64,112,25,['WO-102','WO-201']],
 ['WO-209','Vibration test','Test chambers','TC-03',112,144,0,['WO-208']],
 ['WO-301','Optical alignment','Calibration','CAL-01',48,80,55,['WO-103']],
 ['WO-302','Firmware calibration','Calibration','CAL-02',64,100,10,['WO-102']],
 ['WO-401','System integration','Integration','INT-01',144,192,0,['WO-209','WO-301','WO-302']],
 ['WO-501','Final acceptance','Acceptance','TC-01',192,220,0,['WO-401']],
 ['WO-601','Packaging','Shipping','PACK-01',220,236,0,['WO-501']],
 ['WO-602','Dispatch','Shipping','SHIP-01',240,248,0,['WO-601']],
];
export const SCHEDULE_TASKS:ScheduleTask[]=taskSource.map(([id,label,group,resource,start,end,progress,predecessors])=>({id,label,group,resource,start,end,baselineStart:start,baselineEnd:end,progress,predecessors}));
export function scheduleFrame(tasks= SCHEDULE_TASKS):RecordFrame{return {columns:[['id','Work order','string'],['label','Task','string'],['group','Stage','string'],['resource','Resource','string'],['start','Start (hours from 02 Nov UTC)','number'],['end','End (hours from 02 Nov UTC)','number'],['baselineStart','Baseline start (h)','number'],['baselineEnd','Baseline end (h)','number'],['progress','Progress (%)','number'],['predecessors','Predecessor IDs','string']].map(([key,label,type])=>({key,label,type:type as 'string'|'number'})),rows:tasks.map(t=>[t.id,t.label,t.group,t.resource,t.start,t.end,t.baselineStart,t.baselineEnd,t.progress,t.predecessors.join('|')||'—'])};}

function seed(index:number){const x=Math.sin(index*127.1+311.7)*43758.5453;return x-Math.floor(x);}
export const MATERIAL_CANDIDATES:MaterialCandidate[]=Array.from({length:186},(_,i)=>{
 const matrix=Math.round(12+seed(i+1)*69),fibre=Math.round(8+seed(i+400)*(88-matrix)),filler=100-matrix-fibre;
 const pending=i>=172;
 return {id:`CMP-${String(i+1).padStart(3,'0')}`,matrix,fibre,filler,density:pending?null:Math.round((.95+matrix*.004+filler*.014+seed(i+100)*.11)*1000)/1000,strength:pending?null:Math.round(110+fibre*3.7+matrix*.8+seed(i+80)*75),cost:Math.round((8+fibre*.23+filler*.08+seed(i+200)*4)*100)/100,recycled:Math.round(10+filler*.6+seed(i+300)*18),replicates:pending?0:8+i%7};
});
export function materialFrame(candidates=MATERIAL_CANDIDATES):RecordFrame{return {columns:[{key:'id',label:'Candidate',type:'string'},...['matrix','fibre','filler','density','strength','cost','recycled','replicates'].map(key=>({key,label:{matrix:'Matrix (%)',fibre:'Fibre (%)',filler:'Filler (%)',density:'Density (g/cm³)',strength:'Strength (MPa)',cost:'Cost ($/kg)',recycled:'Recycled (%)',replicates:'Replicates'}[key],type:'number' as const}))],rows:candidates.map(c=>[c.id,c.matrix,c.fibre,c.filler,c.density,c.strength,c.cost,c.recycled,c.replicates])};}

export function explorationWidget(id:string,title:string,pluginId:string,config:Widget['config']={}):Widget{return {id,title,type:'plugin',pluginId,dataKind:'records',providerId:'exploration-fixture',query:`synthetic_${pluginId.replaceAll('-','_')}`,unit:'',layout:{x:0,y:0,w:8,h:6},config,options:{showTooltip:true,showLegend:true,showGrid:true,decimals:2}};}
export function explorationPanel(id:string,title:string,pluginId:string,records:RecordFrame,config:Widget['config']={}):ExplorationPanel{return {widget:explorationWidget(id,title,pluginId,config),result:{records}};}

export function explorationExample(id:string):ExplorationPanel {
 const names:Record<string,string>={'adjacency-matrix':'Observed entity relationships','entity-neighbourhood':'Selected entity neighbourhood','event-swimlanes':'Evidence timeline','resource-gantt':'Work orders and resource allocation','resource-load':'Resource load','schedule-dependencies':'Dependency critical path','ternary-composition':'Formulation space','pareto-scatter':'Strength vs density','parallel-coordinates':'Linked candidate dimensions'};
 const config:Widget['config']=id==='entity-neighbourhood'?{selectedTarget:'api-02'}:id==='resource-gantt'?{editable:false}:id==='event-swimlanes'?{coverageGaps:[THREAT_GAP]}:{};
 return explorationPanel(`example-${id}`,names[id]??id,id,id.startsWith('resource')||id==='schedule-dependencies'?scheduleFrame():['adjacency-matrix','entity-neighbourhood','event-swimlanes'].includes(id)?threatFrame():materialFrame(),config);
}
