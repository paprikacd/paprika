import { useId, useMemo, useRef, useState } from 'react';
import { Dot, MiniTrace, RefPanel, RefSelect } from './ReferenceShared';
import { GeoMap } from '../charts/geo/GeoMap';
import { edgeGeoDecoration, edgeGeoGeometry, edgeGeoLocations } from './edge-geography-fixture';
import { usePlotWidth } from '../components/lab/DomainPrimitives';
import { outcomeBarX, outcomeLayout } from './edge-supporting-layout';
import './EdgeSupporting.css';

const CYAN = 'var(--gamma-chart-1)', AMBER = 'var(--gamma-warning)', RED = 'var(--gamma-danger)', GREEN = 'var(--gamma-success)';

function noise(seed: number) {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return value - Math.floor(value);
}



function Geography({ adaptive }: { adaptive: boolean }) {
  const [filter, setFilter] = useState('All traffic');
  const activeLevel = ['Low risk', 'Medium risk', 'High risk'].indexOf(filter);
  return <RefPanel className="edge-support-geography" title={<>Connection geography <span className="ref-title-light">(proposed)</span></>} info="Deterministic concept locations with zoom, mouse drag, keyboard and non-drag navigation. Enable Touch navigation for map drag/pinch; it starts off so page touch gestures remain available. Scroll zooms at the pointer; outward input at zoom limits returns to page scrolling. The Locations menu exposes exact records. Country outlines use public-domain Natural Earth data; glow and scattered speckles are concept artwork, not individual connections or inferred geographical risk." action={<RefSelect value={filter} onChange={setFilter} options={['All traffic', 'Low risk', 'Medium risk', 'High risk']} label="Geographic traffic filter" />}>
    <div className="edge-map-wrap"><GeoMap label="Synthetic connection geography" locations={edgeGeoLocations} geometry={edgeGeoGeometry} decoration={edgeGeoDecoration} activeSeverity={(['low', 'medium', 'high'] as const)[activeLevel] ?? null} responsive={adaptive} concept/></div>
    <div className="edge-map-legend"><span><Dot color={CYAN}/>Low</span><span><Dot color={AMBER}/>Medium</span><span><Dot color={RED}/>High</span></div>
  </RefPanel>;
}

// Measured bar centres and stack heights in the authored 1592px reference.
// The source image's legend percentages are independent concept annotations.
const referenceOutcomeBars = [
  [632,36,20,5],[642,45,20,5],[654,51,24,8],[665,43,20,6],
  [686,47,23,6],[696,56,24,9],[708,63,26,10],[720,52,23,8],
  [742,48,25,7],[754,58,30,10],[764,64,25,12],[776,59,25,7],
  [800,51,24,5],[812,60,22,11],[824,65,24,16],[834,58,30,9],
  [856,52,22,6],[868,61,25,9],[880,62,23,9],[890,56,29,10],
  [914,47,26,7],[926,49,25,7],[938,55,24,8],[948,50,29,14],
  [972,46,25,7],[984,45,30,5],[994,51,30,12],[1016,52,23,7],
] as const;
function Outcomes({ adaptive }: { adaptive: boolean }) {
  const id=useId().replaceAll(':','');
  const [resolution,setResolution]=useState('5 min buckets');
  const [selected,setSelected]=useState<number|null>(null);
  const [focused,setFocused]=useState(0), stage=useRef<HTMLDivElement>(null), marks=useRef(new Map<number,SVGGElement>());
  const availableWidth=usePlotWidth(stage,446);
  const group=resolution==='15 min buckets'?3:resolution==='10 min buckets'?2:1;
  const buckets=useMemo(()=>Array.from({length:Math.ceil(referenceOutcomeBars.length/group)},(_,index)=>{
    const values=referenceOutcomeBars.slice(index*group,(index+1)*group);
    const allowed=values.reduce((sum,row)=>sum+row[1]*540,0),challenged=values.reduce((sum,row)=>sum+row[2]*540,0),blocked=values.reduce((sum,row)=>sum+row[3]*540,0);
    return {total:allowed+challenged+blocked,allowed,blocked,challenged,referenceX:values[0][0]};
  }),[group]);
  const ceiling=60_000*group, layout=outcomeLayout(availableWidth,buckets.length,group,adaptive),{plot,barWidth}=layout;
  const tickIndices=adaptive&&layout.width<400?[0,2,4,6]:[0,1,2,3,4,5,6];
  return <RefPanel className="edge-support-outcomes" title="Request outcomes" info="Reference composition fixture. Bar positions and stack heights are reconstructed from the supplied concept image. The 72.4/25.1/2.5 legend, time labels and bucket caption are separate authored annotations; they are not a reconciled query export. Grouping combines the reconstructed counts." action={<RefSelect value={resolution} options={['5 min buckets','10 min buckets','15 min buckets']} onChange={value=>{setResolution(value);setSelected(null);}} label="Request outcome grouping" />}>
    <div ref={stage} className="edge-outcomes-stage"><svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="edge-outcomes-chart" style={adaptive?{height:layout.height,width:'100%'}:undefined} role="group" aria-label="Synthetic request outcomes">
      <defs><linearGradient id={`${id}-allowed`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--gamma-chart-1)"/><stop offset="1" stopColor="var(--gamma-chart-1)"/></linearGradient><linearGradient id={`${id}-challenge`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--gamma-warning)"/><stop offset="1" stopColor="var(--gamma-warning)"/></linearGradient></defs>
      {[0,1,2,3,4].map(tick=>{const y=plot.y+tick*plot.h/4;return <g key={tick}><line x1={plot.x} x2={plot.x+plot.w} y1={y} y2={y} stroke="var(--gamma-surface-2)" strokeWidth="1"/><text x="25" y={y+4} textAnchor="end">{tick===4?'0':`${(ceiling/1000)*(4-tick)/4}K`}</text></g>;})}
      {buckets.map((bucket,index)=>{
        const x=outcomeBarX(layout,index,bucket.referenceX,group),allowedH=bucket.allowed/ceiling*plot.h,challengedH=bucket.challenged/ceiling*plot.h,blockedH=bucket.blocked/ceiling*plot.h;
        return <g key={index} ref={node=>{if(node)marks.current.set(index,node);else marks.current.delete(index);}} role="button" tabIndex={adaptive?index===Math.min(focused,buckets.length-1)?0:-1:0} className="edge-outcome-bucket" aria-label={`Concept bucket ${index+1}: ${bucket.allowed.toLocaleString()} allowed, ${bucket.challenged.toLocaleString()} challenged, ${bucket.blocked.toLocaleString()} blocked`} onFocus={()=>setFocused(index)} onClick={()=>setSelected(selected===index?null:index)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setSelected(selected===index?null:index);}if(event.key==='Escape'&&selected!==null){event.preventDefault();event.stopPropagation();setSelected(null);}if(adaptive&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?buckets.length-1:Math.max(0,Math.min(buckets.length-1,index+(event.key==='ArrowLeft'?-1:1)));setFocused(next);setSelected(next);marks.current.get(next)?.focus();}}}>
          <title>{bucket.total.toLocaleString()} requests · {bucket.allowed.toLocaleString()} allowed · {bucket.challenged.toLocaleString()} challenged · {bucket.blocked.toLocaleString()} blocked</title>
          <rect x={x} y={plot.y+plot.h-allowedH} width={barWidth} height={allowedH} fill={`url(#${id}-allowed)`}/>
          <rect x={x} y={plot.y+plot.h-allowedH-challengedH} width={barWidth} height={challengedH} fill={`url(#${id}-challenge)`}/>
          <rect x={x} y={plot.y+plot.h-allowedH-challengedH-blockedH} width={barWidth} height={blockedH} fill={RED}/>
          <rect x={x} y={plot.y+plot.h-bucket.total/ceiling*plot.h} width={barWidth} height={bucket.total/ceiling*plot.h} fill="none" stroke={selected===index?'var(--gamma-ink)':'transparent'} strokeWidth="1.5"/>
        </g>;
      })}
      <line x1={plot.x} x2={plot.x+plot.w} y1={plot.y+plot.h} y2={plot.y+plot.h} stroke="var(--gamma-muted)"/>
      {['13:10','13:15','13:20','13:25','13:30','13:35','13:40'].map((time,index)=>tickIndices.includes(index)&&<text key={time} x={plot.x+12+index*(plot.w-23)/6} y={adaptive?layout.height-14:140} textAnchor="middle">{time}</text>)}
    </svg></div>
    {adaptive&&<label className="edge-outcome-picker">Inspect bucket <select aria-label="Inspect request outcome bucket" value={selected??''} onChange={event=>setSelected(event.target.value===''?null:Number(event.target.value))}><option value="">Choose a bucket</option>{buckets.map((bucket,index)=><option key={index} value={index}>{index+1} · {bucket.total.toLocaleString()} requests</option>)}</select></label>}
    {selected!==null&&<button className="edge-outcome-detail" onClick={()=>setSelected(null)}><strong>{buckets[selected].total.toLocaleString()}</strong> requests · bucket {selected+1} <span>×</span></button>}
    <div className="edge-outcome-legend"><span><Dot color={CYAN}/>Allowed <b>72.4%</b></span><span><Dot color={AMBER}/>Challenged <b>25.1%</b></span><span><Dot color={RED}/>Blocked <b>2.5%</b></span></div>
  </RefPanel>;
}

function Flag({country}:{country:string}) {
  if(country==='US')return <svg viewBox="0 0 22 14" role="img" aria-label="United States"><rect width="22" height="14" fill="#fff"/>{Array.from({length:7},(_,i)=><rect key={i} y={i*2} width="22" height="1" fill="#fa4b5d"/>)}<rect width="9" height="8" fill="#354d9e"/>{Array.from({length:12},(_,i)=><circle key={i} cx={1.4+(i%4)*2} cy={1.4+Math.floor(i/4)*2.2} r=".45" fill="white"/>)}</svg>;
  if(country==='CN')return <svg viewBox="0 0 22 14" role="img" aria-label="China"><rect width="22" height="14" fill="#e8001b"/><path d="m5 2 .7 2.1H8L6.2 5.4 7 7.5 5 6.2 3.2 7.5l.6-2.1L2 4.1h2.3Z" fill="#ffe847"/>{[0,1,2,3].map(i=><circle key={i} cx={9+(i%2)*2} cy={2+i*1.8} r=".65" fill="#ffe847"/>)}</svg>;
  const colors=country==='RU'?['#f1f7ff','#244cc7','#fb4c47']:country==='DE'?['#080e17','#f24740','#ffe74a']:['#ff9a3e','#f6fbff','#00a570'];
  return <svg viewBox="0 0 22 14" role="img" aria-label={country==='RU'?'Russia':country==='DE'?'Germany':'India'}>{colors.map((color,i)=><rect key={color} y={i*14/3} width="22" height={14/3} fill={color}/>)}{country==='IN'&&<circle cx="11" cy="7" r="1.7" stroke="#3152ba" strokeWidth=".6" fill="none"/>}</svg>;
}

const riskRows=[
  {asn:'AS13335',country:'US',color:RED,status:'Blocking',risk:4},
  {asn:'AS4134',country:'CN',color:RED,status:'Challenging',risk:3},
  {asn:'AS7018',country:'RU',color:AMBER,status:'Monitoring',risk:3},
  {asn:'AS16509',country:'DE',color:CYAN,status:'Allowed',risk:2},
  {asn:'AS47956',country:'IN',color:CYAN,status:'Allowed',risk:2},
];

function RiskBySource({ adaptive }: { adaptive: boolean }) {
  const [filter,setFilter]=useState('Top 5 by risk');
  const [selected,setSelected]=useState<string|null>(null);
  const rows=filter==='Allowed sources'?riskRows.filter(row=>row.status==='Allowed'):filter==='Flagged sources'?riskRows.filter(row=>row.status!=='Allowed'):riskRows;
  return <RefPanel className="edge-support-risk" title="Risk by source" info="Authored concept source-risk classifications. Flags represent the synthetic source record's country. Selecting a row highlights that source; the filter changes which classifications are displayed." action={<RefSelect value={filter} options={['Top 5 by risk','Flagged sources','Allowed sources']} onChange={value=>{setFilter(value);setSelected(null);}} label="Source risk filter" />}>
    <table className="edge-risk-table" aria-label="Source risk classifications"><colgroup><col style={{width:adaptive?26:36}}/><col style={{width:adaptive?'21%':94}}/><col style={{width:adaptive?'9%':42}}/><col style={{width:adaptive?'26%':124}}/><col style={{width:adaptive?'20%':97}}/><col/></colgroup><thead><tr><th>#</th><th>Source (ASN)</th><th>Ctry</th><th>Requests (trend)</th><th>Risk</th><th>Status</th></tr></thead><tbody>{rows.map(row=><tr key={row.asn} className={selected===row.asn?'edge-risk-selected':''} onClick={()=>setSelected(selected===row.asn?null:row.asn)}>
      <td>{riskRows.indexOf(row)+1}</td><td><button onClick={event=>{event.stopPropagation();setSelected(selected===row.asn?null:row.asn);}} aria-pressed={selected===row.asn}>{row.asn}</button></td><td><Flag country={row.country}/>{adaptive&&<span className="edge-country-code">{row.country}</span>}</td><td data-label="Requests"><MiniTrace values={Array.from({length:56},(_,i)=>5+noise(i*7+riskRows.indexOf(row)*53)*6+(noise(i*19+riskRows.indexOf(row)*37)>.91?18:0)+(noise(i*31+riskRows.indexOf(row)*11)>.85?9:0))} color={row.color} height={21} width={102} min={0} max={36} fill/></td><td data-label="Risk"><span className="edge-risk-meter" aria-label={`${row.risk} of 6 risk units`}>{Array.from({length:6},(_,i)=><i key={i} style={{background:i<row.risk?(row.status==='Allowed'?GREEN:row.status==='Monitoring'?AMBER:row.color):undefined}}/>)}</span></td><td className={`edge-source-state edge-state-${row.status.toLowerCase()}`}>{row.status}</td>
    </tr>)}</tbody></table>
  </RefPanel>;
}

export function EdgeSupporting({ adaptive = false }: { adaptive?: boolean }) {
  return <div className="edge-supporting-row" data-adaptive={adaptive}><Geography adaptive={adaptive}/><Outcomes adaptive={adaptive}/><RiskBySource adaptive={adaptive}/></div>;
}
