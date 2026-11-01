import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';

export const mapConfig = z.strictObject({ showLabels:z.boolean().default(true), showVectors:z.boolean().default(true), selectedId:z.string().max(100).optional() });
export const intervalConfig = z.strictObject({ showValues:z.boolean().default(true), selectedId:z.string().max(100).optional() });
export const spectrumConfig = z.strictObject({ showPeakHold:z.boolean().default(true), showGrid:z.boolean().default(true) });
export const iqConfig = z.strictObject({ showIdeal:z.boolean().default(true), showGrid:z.boolean().default(true) });
export const roseConfig = z.strictObject({ showValues:z.boolean().default(true) });
export const curtainConfig = z.strictObject({ showGrid:z.boolean().default(false) });

export function rows(frame:RecordFrame|undefined,required:string[],limit=25000) {
  if(!frame)return [];
  const columns=new Map(frame.columns.map((c,i)=>[c.key,i]));
  if(columns.size!==frame.columns.length)throw new Error('Spatial chart columns must have unique keys.');
  for(const key of required)if(!columns.has(key))throw new Error(`Missing spatial chart column “${key}”.`);
  if(frame.rows.length>limit)throw new Error(`This chart accepts at most ${limit.toLocaleString()} records. Aggregate source data explicitly.`);
  return frame.rows.map(row=>Object.fromEntries(frame.columns.map((c,i)=>[c.key,row[i]])));
}
export function finite(v:unknown,name:string,nullable=false):number|null { if(v===null&&nullable)return null;if(typeof v!=='number'||!Number.isFinite(v))throw new Error(`${name} must be finite${nullable?' or null':''}.`);return v; }
export function identity(v:unknown,name='id'):string {if(typeof v!=='string'||!v.trim())throw new Error(`${name} must be nonempty text.`);return v;}
function unique<T extends {id:string}>(data:T[]) {const ids=new Set<string>();for(const p of data){if(ids.has(p.id))throw new Error(`Duplicate identity “${p.id}”.`);ids.add(p.id);}return data;}
function coordinate(v:unknown,axis:'longitude'|'latitude'){const n=finite(v,axis)!;if(Math.abs(n)>(axis==='latitude'?90:180))throw new Error(`Invalid ${axis}.`);return n;}
export type Shipment={id:string;source:string;destination:string;sourceLon:number;sourceLat:number;longitude:number;latitude:number;viaLon:number|null;viaLat:number|null;low:number;median:number;high:number;promise:number;risk:number;cause:string;carrier:string};
export function shipments(frame:RecordFrame|undefined):Shipment[]{return unique(rows(frame,['id','source','destination','sourceLon','sourceLat','longitude','latitude','low','median','high','promise','risk'],120).map(r=>{
  const low=finite(r.low,'ETA low')!,median=finite(r.median,'ETA median')!,high=finite(r.high,'ETA high')!,promise=finite(r.promise,'Promised time')!,risk=finite(r.risk,'Delay probability')!;
  if(low>median||median>high)throw new Error('Arrival bounds must contain the median.');if(risk<0||risk>100)throw new Error('Delay probability must be 0–100%.');
  const viaLon=r.viaLon==null?null:coordinate(r.viaLon,'longitude'),viaLat=r.viaLat==null?null:coordinate(r.viaLat,'latitude');if((viaLon===null)!==(viaLat===null))throw new Error('Waypoint coordinates must be supplied together.');
  return {id:identity(r.id),source:identity(r.source),destination:identity(r.destination),sourceLon:coordinate(r.sourceLon,'longitude'),sourceLat:coordinate(r.sourceLat,'latitude'),longitude:coordinate(r.longitude,'longitude'),latitude:coordinate(r.latitude,'latitude'),viaLon,viaLat,low,median,high,promise,risk,cause:String(r.cause??''),carrier:String(r.carrier??'')};
}));}
export type Dwell={id:string;min:number;q1:number;median:number;q3:number;max:number;samples:number;outliers:number[]};
export function dwellRows(frame:RecordFrame|undefined):Dwell[]{return unique(rows(frame,['id','min','q1','median','q3','max','samples'],40).map(r=>{const values=['min','q1','median','q3','max'].map(k=>finite(r[k],k)!);if(values.some((v,i)=>v<0||(i>0&&v<values[i-1])))throw new Error('Dwell quantiles must be nonnegative and ordered.');const samples=finite(r.samples,'Sample count')!;if(!Number.isInteger(samples)||samples<1)throw new Error('Sample count must be a positive integer.');return {id:identity(r.id),min:values[0],q1:values[1],median:values[2],q3:values[3],max:values[4],samples,outliers:[r.outlier1,r.outlier2].filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0)};}));}
export type FieldCell={id:string;x:number;y:number;value:number|null};
/** Dense fields may arrive as bounded scalar wide frames: x plus `value@y:y-coordinate` columns. */
export function fieldCells(frame:RecordFrame|undefined,xKey:string,yKey:string,valueKey:string):FieldCell[]{
  if(!frame)return [];
  const prefix=`${valueKey}@${yKey}:`,wide=frame.columns.filter(c=>c.key.startsWith(prefix));
  const data=wide.length?rows(frame,[xKey],1000).flatMap(r=>{
    const x=finite(r[xKey],xKey)!;
    return wide.map(c=>{const y=finite(Number(c.key.slice(prefix.length)),yKey)!,value=finite(r[c.key],valueKey,true);return{id:`${x}:${y}`,x,y,value};});
  }):rows(frame,[xKey,yKey,valueKey],1000).map(r=>{const x=finite(r[xKey],xKey)!,y=finite(r[yKey],yKey)!,value=finite(r[valueKey],valueKey,true);return{id:`${x}:${y}`,x,y,value};});
  if(data.length>25000)throw new Error('Field charts accept at most 25,000 cells; aggregate source observations explicitly.');
  return unique(data);
}
export function fieldAxes(data:FieldCell[]){return{x:[...new Set(data.map(p=>p.x))].sort((a,b)=>a-b),y:[...new Set(data.map(p=>p.y))].sort((a,b)=>a-b)};}
export function bandBounds(a:number,b:number,low:number,high:number,minSpan=.001):[number,number]{if(![a,b,low,high,minSpan].every(Number.isFinite)||low>=high||minSpan<=0)throw new Error('Invalid frequency domain.');const span=Math.min(minSpan,high-low);let l=Math.max(low,Math.min(high,Math.min(a,b))),r=Math.min(high,Math.max(low,Math.max(a,b)));if(r-l<span){const center=Math.max(low+span/2,Math.min(high-span/2,(l+r)/2));l=center-span/2;r=center+span/2;}return[Math.max(low,l),Math.min(high,r)];}
export function nearestValue(values:number[],value:number){return values.reduce((a,b)=>Math.abs(b-value)<Math.abs(a-value)?b:a,values[0]??value);}
export function fieldColor(value:number|null,min:number,max:number){if(value===null)return'#354854';const t=Math.max(0,Math.min(1,(value-min)/(max-min||1)));const stops=[[15,30,76],[25,55,151],[7,139,193],[23,207,185],[225,222,72],[250,112,52]];const i=Math.min(stops.length-2,Math.floor(t*(stops.length-1))),f=t*(stops.length-1)-i;return`rgb(${stops[i].map((v,j)=>Math.round(v+(stops[i+1][j]-v)*f)).join(',')})`;}
export type Buoy={id:string;kind:string;label:string;longitude:number;latitude:number;u:number|null;v:number|null;wave:number|null;temperature:number|null;coverage:number|null};
export function buoyRows(frame:RecordFrame|undefined):Buoy[]{return unique(rows(frame,['id','kind','label','longitude','latitude','u','v'],1000).map(r=>{const u=finite(r.u,'Eastward current',true),v=finite(r.v,'Northward current',true);if((u===null)!==(v===null))throw new Error('Both current vector components must be observed or unknown.');return{id:identity(r.id),kind:identity(r.kind),label:String(r.label??''),longitude:coordinate(r.longitude,'longitude'),latitude:coordinate(r.latitude,'latitude'),u,v,wave:finite(r.wave??null,'Wave height',true),temperature:finite(r.temperature??null,'Temperature',true),coverage:finite(r.coverage??null,'Coverage',true)};}));}
export function vectorBearing(u:number,v:number){return(Math.atan2(u,v)*180/Math.PI+360)%360;}
export function fitEquirectangular(bounds:{west:number;east:number;south:number;north:number},width:number,height:number){if(![...Object.values(bounds),width,height].every(Number.isFinite)||bounds.east<=bounds.west||bounds.north<=bounds.south||bounds.west< -180||bounds.east>180||bounds.south< -90||bounds.north>90||width<=0||height<=0)throw new Error('Invalid geographic extent.');const cosine=Math.cos((bounds.north+bounds.south)/2*Math.PI/180),scale=Math.min(width/((bounds.east-bounds.west)*cosine),height/(bounds.north-bounds.south));const ox=(width-(bounds.east-bounds.west)*cosine*scale)/2,oy=(height-(bounds.north-bounds.south)*scale)/2;return{project:(lon:number,lat:number)=>({x:ox+(lon-bounds.west)*cosine*scale,y:oy+(bounds.north-lat)*scale}),landTransform:`translate(${ox-(bounds.west+180)*cosine*scale} ${oy-(90-bounds.north)*scale}) scale(${cosine*scale/2} ${scale/2})`};}
export type RoseCell={id:string;direction:number;speed:string;count:number};
export function roseRows(frame:RecordFrame|undefined):RoseCell[]{const data=unique(rows(frame,['direction','speed','count'],256).map(r=>{const direction=finite(r.direction,'Direction')!,count=finite(r.count,'Count')!,speed=identity(r.speed);if(direction<0||direction>=360||count<0||!Number.isInteger(count))throw new Error('Rose direction must be 0–360° and counts nonnegative integers.');return{id:`${direction}:${speed}`,direction,speed,count};}));if(!data.length)return data;const directions=[...new Set(data.map(p=>p.direction))].sort((a,b)=>a-b),speeds=new Set(data.map(p=>p.speed)),step=360/directions.length;if(directions.length<3||directions.some((d,i)=>Math.abs(((directions[(i+1)%directions.length]-d+360)%360)-step)>1e-6))throw new Error('Rose direction bins must cover the full circle at equal angular widths.');if(data.length!==directions.length*speeds.size)throw new Error('Every rose direction must include each speed bin; missing observations cannot be zero-filled.');return data;}
export function polarPoint(angle:number,radius:number){const a=(angle-90)*Math.PI/180;return{x:Math.cos(a)*radius,y:Math.sin(a)*radius};}
export function roseSector(direction:number,inner:number,outer:number,width=22.5){const a=polarPoint(direction-width/2,outer),b=polarPoint(direction+width/2,outer),c=polarPoint(direction+width/2,inner),d=polarPoint(direction-width/2,inner);return`M${a.x},${a.y}A${outer},${outer} 0 0 1 ${b.x},${b.y}L${c.x},${c.y}${inner>0?`A${inner},${inner} 0 0 0 ${d.x},${d.y}`:''}Z`;}
export type IQPoint={id:string;i:number;q:number;idealI:number;idealQ:number};
export function iqRows(frame:RecordFrame|undefined):IQPoint[]{return unique(rows(frame,['id','i','q','idealI','idealQ'],10000).map(r=>({id:identity(r.id),i:finite(r.i,'In-phase')!,q:finite(r.q,'Quadrature')!,idealI:finite(r.idealI,'Ideal I')!,idealQ:finite(r.idealQ,'Ideal Q')!})));}
export function rmsEvm(points:IQPoint[]){const signal=points.reduce((s,p)=>s+p.idealI**2+p.idealQ**2,0),noise=points.reduce((s,p)=>s+(p.i-p.idealI)**2+(p.q-p.idealQ)**2,0);return signal?Math.sqrt(noise/signal)*100:null;}
