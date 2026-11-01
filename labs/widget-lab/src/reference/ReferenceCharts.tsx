import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ArrowRight, Bookmark, Clock3, X } from 'lucide-react';
import { area, line } from 'd3-shape';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { z } from 'zod';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from '../vendor/paprika/ui/src/features/insights/widget-registry';
import { useChartCursorPublisher } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import type { QueryResult, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import { Dot, MiniTrace, RefPanel } from './ReferenceShared';
import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { ChartTooltip } from '../components/lab/ChartTooltip';
import { restoreTooltipFocus } from '../vendor/paprika/ui/src/features/insights/tooltip-focus';
import { useTooltipDismiss } from '../components/lab/useTooltipDismiss';
import { edgeIngressProfile, edgeEgressProfile, burnOneHourProfile, burnSixHourProfile } from './reference-profiles';
import './ReferenceCharts.css';
import {edgeHistoryIngress,edgeHistoryEgress} from './reference-mini-profiles';
import { formatWindowDuration, minimumTimeWindow, nearestTimeIndex, observationsInWindow, timeWindowExtent } from '../vendor/paprika/ui/src/features/insights/time-window';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../vendor/paprika/ui/src/features/insights/time-window-controls';
import { referenceBandLabel, referenceChartLayout, referenceTickAnchor } from './reference-chart-layout';

export const referenceChartConfig = z.strictObject({ kind: z.enum(['edge','reliability']), service: z.string().max(80).default('uptime-api'), gateway: z.string().max(80).default('edge-01'), phase: z.number().int().min(0).max(100000).default(0) });
type Kind = 'edge'|'reliability';
const EDGE_Y=scaleLinear().domain([-1200,0,1400]).range([217,130,17]);
const BURN_Y=scaleLinear().domain([0,1,2,4,8]).range([194,155,115,77,12]);
const initialIndex = {edge:202,reliability:176};
const exactTime = {edge:Date.UTC(2024,4,29,13,32,8),reliability:Date.UTC(2024,4,16,10,40)};
const ranges = {edge:[Date.UTC(2024,4,29,13,10),Date.UTC(2024,4,29,13,45)],reliability:[Date.UTC(2024,4,1),Date.UTC(2024,4,31)]};

/** Authored visual fixtures, deliberately distinct from the analytical lab's queries. */
export function makeReferenceResult(kind:Kind, service='uptime-api', phase=0, gateway='edge-01'): QueryResult {
  const sources=kind==='edge'?[edgeIngressProfile,edgeEgressProfile]:[burnOneHourProfile,burnSixHourProfile];
  const timestamps=scaleLinear().domain([0,initialIndex[kind],360]).range([ranges[kind][0],exactTime[kind],ranges[kind][1]]);
  const y=kind==='edge'?EDGE_Y:BURN_Y;
  const sourceTop=kind==='edge'?259:314;
  const factor=kind==='reliability'?({ 'payment-api':1.38,'auth-api':1.12,'catalog-api':.67,'search-api':.91,'worker-api':1.2 }[service]??1):1;
  const names=kind==='edge'?['Ingress','Egress']:['1h burn rate','6h burn rate'];
  const labels: Record<string,string> = kind==='edge'?{gateway,source:'192.0.2.14',fixture:'reference concept'}:{service,fixture:'reference concept'};
  return {series:sources.map((profile,s)=>({name:names[s],labels,points:profile.map((py,i)=>{
    let value=y.invert(py-sourceTop)*factor;
    if(i===initialIndex[kind]) value=(kind==='edge'?[912.36,-312.18]:[1.42,.81])[s]*factor;
    if(phase) value*=1+.018*Math.sin(i*.19+phase*.35);
    const inGap=kind==='reliability'&&i>=290&&i<=325;
    return {timestamp:Math.round(timestamps(i))+phase*(kind==='edge'?10000:3600000),value:inGap?null:value};
  })}))};
}

function ReferenceChartRenderer({widget,result,onContextChange,embedded}:WidgetRendererProps) {
  const cfg=referenceChartConfig.parse(widget.config), kind=cfg.kind, edge=kind==='edge';
  const id=useId().replace(/:/g,''), svgRef=useRef<SVGSVGElement>(null), publisher=useChartCursorPublisher();
  const series=result.series??[], n=series[0]?.points.length??0;
  const [selected,setSelected]=useState<number|null>(null);
  const [pinned,setPinned]=useState(false);
  const selectionSource=useRef(result), detailTrigger=useRef<HTMLButtonElement|null>(null), returningFocus=useRef(false);
  const inspectable=!embedded&&widget.options?.showTooltip!==false;
  const [detail,setDetail]=useState<'query'|'events'|null>(null);
  const dismissal=useTooltipDismiss({onDismiss:()=>{setSelected(null);setPinned(false);setDetail(null);publisher.clear(widget.id);},pinned,revision:result,enabled:inspectable});
  const wrapperRef=useRef<HTMLDivElement>(null), baseWidth=edge?946:933;
  const [layout,setLayout]=useState({reflow:true,width:baseWidth});
  useLayoutEffect(()=>{
    const wrapper=wrapperRef.current; if(!wrapper)return;
    const shell=wrapper.closest<HTMLElement>('.ref-app');
    const measure=()=>{const reflow=shell?.dataset.layout!=='literal', style=getComputedStyle(wrapper), measured=Math.max(1,wrapper.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0));if(!wrapper.clientWidth)return;setLayout(previous=>previous.reflow===reflow&&previous.width===measured?previous:{reflow,width:measured});};
    const resize=new ResizeObserver(measure);resize.observe(wrapper);
    const attributes=new MutationObserver(measure);if(shell)attributes.observe(shell,{attributes:true,attributeFilter:['data-layout','style','class']});
    measure();return()=>{resize.disconnect();attributes.disconnect();};
  },[baseWidth,n>0]);
  const geometry=referenceChartLayout(kind,layout.width,layout.reflow),{width,height:svgHeight,plot,yFromSource}=geometry;
  const sourceY=edge?EDGE_Y:BURN_Y,y=sourceY.copy().range(sourceY.range().map(yFromSource));
  const extent=useMemo(()=>timeWindowExtent(series),[series]);
  const minimumSpan=useMemo(()=>extent?minimumTimeWindow(series,extent):1,[series,extent]);
  const windowState=useChartTimeWindow(extent,result,minimumSpan);
  const temporal=windowState.zoomed||layout.reflow;
  const x=scaleLinear().domain([0,n-1]).range([plot.left,plot.left+plot.width]);
  const timeX=scaleLinear().domain([windowState.window.start,windowState.window.end]).range([plot.left,plot.left+plot.width]);
  // Full literal mode retains the artwork's calibrated positions; its inverse still
  // maps through the source timestamps. Every zoom/reflow uses elapsed time.
  const authoredTimeX=scaleLinear().domain(series[0]?.points.map(point=>point.timestamp)??[0,1]).range(series[0]?.points.map((_,index)=>(edge?55:52)+index/Math.max(1,n-1)*(edge?874:859))??[plot.left,plot.left+plot.width]);
  const pointX=(timestamp:number,index:number)=>temporal?timeX(timestamp):x(index);
  const timeAtX=(position:number)=>temporal?timeX.invert(position):authoredTimeX.invert(position);
  const brush=useTimeWindowBrush({enabled:!embedded&&windowState.enabled,revision:result,window:windowState.window,
    point:(clientX,clientY)=>{
      const svg=svgRef.current, matrix=svg?.getScreenCTM();if(!svg||!matrix)return null;
      const local=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());
      const px=Math.max(plot.left,Math.min(plot.left+plot.width,local.x));
      return {x:px,y:local.y,timestamp:timeAtX(px),inPlot:local.x>=plot.left&&local.x<=plot.left+plot.width&&local.y>=plot.top&&local.y<=plot.top+plot.height};
    },commit:windowState.commit,onStart:()=>{dismissal.cancel();setSelected(null);setPinned(false);setDetail(null);publisher.clear(widget.id);},
  });
  const previousWindow=useRef(`${windowState.window.start}:${windowState.window.end}`);
  useEffect(()=>{const key=`${windowState.window.start}:${windowState.window.end}`;if(previousWindow.current!==key){previousWindow.current=key;setSelected(null);setPinned(false);setDetail(null);publisher.clear(widget.id);}},[windowState.window.start,windowState.window.end,publisher,widget.id]);
  const selectedIndex=!inspectable||selectionSource.current!==result||selected===null||n===0||series[0].points[Math.min(selected,n-1)].timestamp<windowState.window.start||series[0].points[Math.min(selected,n-1)].timestamp>windowState.window.end?null:Math.min(selected,n-1);
  const stamp=selectedIndex===null?undefined:series[0]?.points[selectedIndex]?.timestamp;
  const values=selectedIndex===null?[]:[0,1].map(index=>series[index]?.points[selectedIndex]?.value??null);
  const colors=edge?['#00d9f3','#9868f3']:['#00b9ff','#9754fa'];
  const names=edge?['Ingress','Egress']:['1h burn rate','6h burn rate'];
  useEffect(()=>{setSelected(null);setPinned(false);setDetail(null);},[result,kind,inspectable]);
  useEffect(()=>{ if(stamp!==undefined)publisher.publish(widget.id,stamp,pinned);else publisher.clear(widget.id);return()=>publisher.clear(widget.id); },[stamp,pinned,publisher,widget.id]);
  const close=()=>{dismissal.cancel();setSelected(null);setPinned(false);setDetail(null);publisher.clear(widget.id);returningFocus.current=true;restoreTooltipFocus(svgRef.current);returningFocus.current=false;};
  const closeDetail=()=>{setDetail(null);restoreTooltipFocus(detailTrigger.current);};
  const openDetail=(next:'query'|'events',trigger:HTMLButtonElement)=>{dismissal.cancel();detailTrigger.current=trigger;setPinned(true);setDetail(next);};
  const observe=(event:Pick<PointerEvent<SVGSVGElement>,'currentTarget'|'clientX'|'clientY'>, pin=false)=>{
    if(!inspectable || brush.active || (pinned&&!pin))return;
    const matrix=event.currentTarget.getScreenCTM();if(!matrix)return;
    const px=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse()).x;
    const index=nearestTimeIndex(series[0]?.points??[],timeAtX(Math.max(plot.left,Math.min(plot.left+plot.width,px))),windowState.window);
    if(index===null)return;
    dismissal.cancel();selectionSource.current=result;setSelected(index);setPinned(pin);
    if(pin)onContextChange?.({series:names[0],labels:series[0]?.labels??{},value:series[0]?.points[index]?.value??null});
  };
  const keyboard=(event:KeyboardEvent<SVGSVGElement>)=>{
    if(!inspectable)return;
    dismissal.cancel();selectionSource.current=result;
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();const indices=(series[0]?.points??[]).map((point,index)=>({point,index})).filter(({point})=>point.timestamp>=windowState.window.start&&point.timestamp<=windowState.window.end).map(({index})=>index);
      if(indices.length)setSelected(current=>event.key==='Home'?indices[0]:event.key==='End'?indices.at(-1)!:indices[Math.max(0,Math.min(indices.length-1,Math.max(0,indices.indexOf(current??initialIndex[kind]))+(event.key==='ArrowRight'?1:-1)))]);setPinned(false);
    }else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(selected===null)setSelected(nearestTimeIndex(series[0]?.points??[],(windowState.window.start+windowState.window.end)/2,windowState.window));setPinned(v=>!v);}else if(event.key==='Escape'){event.preventDefault();if(detail)closeDetail();else close();}
  };
  const yTicks=edge?[1200,800,400,0,-400,-800,-1200]:[8,4,2,1,0];
  const sourceXTicks=edge?['13:10','13:15','13:20','13:25','13:30','13:35','13:40']:['May 01','May 04','May 07','May 10','May 13','May 16','May 19','May 22','May 25','May 28','May 31'];
  const sourceTickPositions=edge?[69,176,270,361,453,547,871]:[52,121,190,262,332,402,472,542,755,826,896];
  const tickTimes=temporal?scaleUtc().domain([new Date(windowState.window.start),new Date(windowState.window.end)]).ticks(Math.max(2,Math.min(7,Math.floor(plot.width/105)))):[];
  const xTicks=temporal?tickTimes.map(date=>windowState.window.end-windowState.window.start>86400000?`${date.toISOString().slice(5,10)}${windowState.window.end-windowState.window.start<4*86400000?' '+date.toISOString().slice(11,16):''}`:date.toISOString().slice(11,windowState.window.end-windowState.window.start<600000?19:16)):sourceXTicks;
  const tickPositions=temporal?tickTimes.map(date=>timeX(+date)):sourceTickPositions;
  const guide=selectedIndex===null?null:pointX(series[0].points[selectedIndex].timestamp,selectedIndex);
  const incidentStart=temporal?timeX(authoredTimeX.invert(206)):206,incidentEnd=temporal?timeX(authoredTimeX.invert(256)):256;
  const missingStart=temporal?timeX(series[0]?.points[290]?.timestamp??windowState.window.end):744,missingEnd=temporal?timeX(series[0]?.points[325]?.timestamp??windowState.window.end):829;
  const incidentLabel=layout.reflow?referenceBandLabel(incidentStart,incidentEnd,plot.left,plot.left+plot.width,49):incidentStart+2;
  const missingLabel=layout.reflow?referenceBandLabel(missingStart,missingEnd,plot.left,plot.left+plot.width,50):missingStart+20;
  const date=stamp===undefined?'':new Date(stamp);
  const dateText=typeof date==='string'?'':`${date.toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'2-digit',year:'numeric'})}  ${date.toISOString().slice(11,19)}`;
  const seriesValues=(index:number)=>(temporal?observationsInWindow(series[index]?.points??[],windowState.window):series[index]?.points??[]).map(p=>p.value);
  const path=(s:number,fill=false)=>{
    const points=series[s]?.points??[];
    if(fill)return area<(typeof points)[number]>().defined(p=>p.value!==null).x((point,i)=>pointX(point.timestamp,i)).y0(y(0)).y1(p=>y(p.value!))(points)??'';
    return line<(typeof points)[number]>().defined(p=>p.value!==null).x((point,i)=>pointX(point.timestamp,i)).y(p=>y(p.value!))(points)??'';
  };
  if(n===0)return <div className={`ref-chart ref-chart-${kind} ref-chart-empty`} role="status">No reference observations</div>;
  const legendValues=names.map((_,index)=>selectedIndex===null?(windowState.zoomed?observationsInWindow(series[index]?.points??[],windowState.window).at(-1)?.value??null:series[index]?.points[Math.min(initialIndex[kind],n-1)]?.value??null):values[index]);
  return <div ref={wrapperRef} className={`ref-chart ref-chart-${kind}`} data-responsive={layout.reflow} data-window-active={windowState.zoomed} data-time-axis={temporal?'elapsed':'reference-calibration'}>
    {!embedded&&extent&&<TimeWindowControls state={windowState} compact/>}
    <svg ref={svgRef} className="ref-chart-svg" width={width} height={svgHeight} viewBox={`0 0 ${width} ${svgHeight}`} role="img" aria-label={edge?'Network traffic chart':'Availability burn rate chart'} aria-description="Synthetic reference reconstruction. Arrow keys inspect, Enter pins, Escape closes. Drag horizontally to change this chart window; Time window provides exact UTC bounds, Undo and Reset. Dashboard values remain unchanged." tabIndex={inspectable?0:-1} {...brush.handlers} style={{touchAction: 'pan-y',userSelect:'none'}} onPointerMove={event=>{if(!brush.active)observe(event);}} onPointerLeave={()=>{brush.handlers.onPointerLeave();if(!pinned&&!brush.active)dismissal.schedule();}} onFocus={()=>{if(inspectable&&!pinned&&!returningFocus.current){dismissal.cancel();selectionSource.current=result;setSelected(current=>current??nearestTimeIndex(series[0]?.points??[],(windowState.window.start+windowState.window.end)/2,windowState.window));}}} onBlur={()=>{if(!pinned)dismissal.schedule();}} onClick={event=>observe(event,true)} onKeyDown={keyboard}>
      <defs>
        <clipPath id={`plot-${id}`}><rect x={plot.left} y={plot.top} width={plot.width} height={plot.height}/></clipPath>
        {colors.map((color,s)=><linearGradient key={color} id={`area-${id}-${s}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={s===1&&edge?plot.top+plot.height:plot.top} y2={y(0)}><stop offset="0" stopColor={color} stopOpacity={edge ? .74 : .45}/><stop offset="1" stopColor={color} stopOpacity={edge ? .38 : .04}/></linearGradient>)}
        <pattern id={`incident-${id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" x2="0" y1="0" y2="5" stroke="#df4944" strokeWidth="1.4" opacity=".45"/></pattern>
        <pattern id={`missing-${id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" x2="0" y1="0" y2="5" stroke="#507585" strokeWidth="1" opacity=".6"/></pattern>
      </defs>
      {edge&&<text className="ref-chart-unit" x="12" y="12">Mb/s</text>}
      {(layout.reflow?tickPositions:Array.from({length:edge?16:13},(_,i)=>plot.left+i*plot.width/(edge?15:12))).map(position=><line key={`x${position}`} x1={position} x2={position} y1={plot.top} y2={plot.top+plot.height} className="ref-grid-line"/>)}
      {yTicks.map(value=><g key={value}><line x1={plot.left} x2={plot.left+plot.width} y1={y(value)} y2={y(value)} className={value===0&&edge?'ref-zero-line':'ref-grid-line'}/><text x={plot.left-12} y={y(value)+4} textAnchor="end" className={value===2&&!edge?'ref-tick-threshold':'ref-chart-tick'}>{edge?(Math.abs(value)>=1000?`${value<0?'−':''}1.2K`:String(value).replace('-','−')):`${value.toFixed(1)}x`}</text></g>)}
      {!edge&&<g clipPath={temporal?`url(#plot-${id})`:undefined}><rect x={incidentStart} y={yFromSource(41)} width={Math.max(0,incidentEnd-incidentStart)} height={yFromSource(194)-yFromSource(41)} fill="#d4454333"/><rect x={incidentStart} y={yFromSource(41)} width={Math.max(0,incidentEnd-incidentStart)} height={yFromSource(194)-yFromSource(41)} fill={`url(#incident-${id})`} stroke="#e4433a" strokeWidth=".8"><title>Authored incident interval</title></rect>{incidentLabel!==null&&<text className="ref-chart-annotation" x={incidentLabel} y={yFromSource(32)} textAnchor={layout.reflow?'middle':undefined} fill="#ff4c3f" fontSize="14">Incident</text>}<rect x={missingStart} y={plot.top} width={Math.max(0,missingEnd-missingStart)} height={plot.height} fill={`url(#missing-${id})`} stroke="#39515d" strokeWidth=".7"><title>Unknown observations in this interval</title></rect>{missingLabel!==null&&<text className="ref-chart-annotation" x={missingLabel} y={yFromSource(68)} textAnchor={layout.reflow?'middle':undefined} fill="#b6ccdf" fontSize="14">No data</text>}</g>}
      <g clipPath={`url(#plot-${id})`}>{series.map((s,i)=><g key={s.name}><path d={path(i,true)} fill={`url(#area-${id}-${i})`}/><path d={path(i)} fill="none" stroke={colors[i]} strokeWidth={edge?1.35:1.15} strokeLinejoin="round" strokeLinecap="round"/></g>)}</g>
      {!edge&&<line x1={plot.left} x2={plot.left+plot.width} y1={y(2)} y2={y(2)} stroke="#ffbb05" strokeWidth="1.4" strokeDasharray="7 3"/>}
      {guide!==null&&!brush.preview&&<g pointerEvents="none"><line x1={guide} x2={guide} y1={plot.top} y2={plot.top+plot.height} stroke="#d5e5f2" strokeWidth="1.5" strokeDasharray="7 4"/>{values.map((value,s)=>value!==null&&<g key={s}><circle cx={guide} cy={y(value)} r="8.3" fill={colors[s]} opacity=".2"/><circle cx={guide} cy={y(value)} r="6.1" fill={colors[s]} stroke="#e4f7ff" strokeWidth="1.8"/><circle cx={guide} cy={y(value)} r="2" fill="#fff"/></g>)}{!edge&&<circle cx={guide} cy={y(2)} r="6.1" fill="#00b9ff" stroke="#dff8ff" strokeWidth="1.8"/>}</g>}
      {brush.preview&&<g pointerEvents="none" data-time-brush-selection><rect x={Math.min(brush.preview.x1,brush.preview.x2)} y={plot.top} width={Math.abs(brush.preview.x2-brush.preview.x1)} height={plot.height} fill="#00d9f32b" stroke="#00cce9" strokeWidth="1"/><text x={(brush.preview.x1+brush.preview.x2)/2} y={plot.top+18} textAnchor="middle" fill="#e8f9ff" fontSize="13">{formatWindowDuration(Math.abs(brush.preview.end-brush.preview.start))}</text></g>}
      {xTicks.map((label,i)=><text key={label} x={tickPositions[i]} y={plot.top+plot.height+(edge?24:21)} textAnchor={layout.reflow?referenceTickAnchor(tickPositions[i],label.length*7,width):'middle'} className="ref-chart-tick">{label}</text>)}
    </svg>
    <div className="ref-chart-legend">{names.map((name,i)=><span key={name}><Dot color={colors[i]}/>{edge?`${name} (${i?'outbound, −':'inbound, +'})`:name}{!edge&&<strong style={{color:i?'#00efbc':undefined}}>{legendValues[i]===null?'No data':`${legendValues[i].toFixed(2)}x`}</strong>}</span>)}{!edge&&<><span><i className="ref-threshold-key"/>2x threshold</span><span><i className="ref-incident-key"/>Incident</span><span className="ref-unknown-key-label"><i className="ref-unknown-key"/>Unknown data</span></>}</div>
    {selectedIndex!==null&&inspectable&&<ChartTooltip pinned={pinned} onClose={reason=>{if(detail&&(reason===undefined||reason==='escape'||reason==='close'))closeDetail();else close();}}><section className="ref-inspector" aria-label={pinned?'Pinned observation':'Observation'} data-pinned={pinned}>
      <button className="ref-inspector-close" aria-label="Close observation" onClick={close}><X size={12}/></button>
      <div className="ref-inspector-time">{edge?<Clock3 size={16}/>:<Bookmark size={15}/>}<time dateTime={new Date(stamp!).toISOString()}>{dateText}</time></div>
      <div className="ref-inspector-values">{names.map((name,s)=><div key={name}><span><Dot color={colors[s]}/>{name}</span><strong>{values[s]===null?'No data':`${values[s]?.toFixed(2)}${edge?' Mb/s':'x'}`}</strong></div>)}</div>
      {!edge&&<div className="ref-inspector-slo"><span>SLO<strong>99.90%</strong></span><span>Achieved<strong>99.96%</strong></span></div>}
      <div className="ref-inspector-context"><span>Source<strong>{edge?'192.0.2.14':cfg.service}</strong></span>{edge&&<span>Gateway<strong>{cfg.gateway}</strong></span>}</div>
      <div className="ref-inspector-histories">{names.map((name,s)=><div className="ref-inspector-history" key={name}><span>{temporal?`${name} (window)`:edge?`${name} (hist)`:`${s?'6h':'1h'} (24h)`}</span><div><MiniTrace values={edge&&!temporal?[...(s?edgeHistoryEgress:edgeHistoryIngress)]:seriesValues(s)} color={colors[s]} height={edge?25:23} min={edge&&!temporal?0:undefined} max={edge&&!temporal?25:undefined} fill/></div></div>)}</div>
      <footer><button onClick={event=>openDetail(edge?'query':'events',event.currentTarget)}>{edge?'Inspect query':'View events'}<ArrowRight size={16}/></button><button onClick={event=>openDetail(edge?'events':'query',event.currentTarget)}>{edge?'View events':'Inspect query'}<ArrowRight size={16}/></button></footer>
    {detail&&<div className="ref-chart-detail" role="region" aria-label={detail==='query'?'Reference query details':'Reference event context'}><header><strong>{detail==='query'?'Reference query details':'Reference event context'}</strong><button onClick={closeDetail} aria-label="Close chart detail"><X size={16}/></button></header>{detail==='query'?<><p>Authored synthetic reference fixture · {edge?cfg.gateway:cfg.service}</p><p>The geometry and initial labels reconstruct the supplied concept. Occluded trace segments are deterministic reconstructions. The unzoomed desktop axis follows the artwork; zoomed and reflowed plots use actual source timestamps. The chart window changes this plot only and leaves dashboard summaries unchanged.</p><code>{edge?'reference.edge.traffic{gateway="'+cfg.gateway+'"}':'reference.slo.burn{service="'+cfg.service+'"}'}</code><table><thead><tr><th>Series</th><th>Selected observation</th></tr></thead><tbody>{names.map((name,i)=><tr key={name}><td>{name}</td><td>{values[i]?.toFixed(2)??'No data'} {edge?'Mb/s':'x'}</td></tr>)}</tbody></table></>:<><p>Selected observation: {dateText} UTC. The record below is authored reference context; it is not inferred from this timestamp.</p><p>{edge?'May 29, 2024 13:35:12 UTC · edge-01':'May 16, 2024 10:21:00 UTC · payment-api'}</p><p>{edge?'geo-block: country · 124 blocked requests':'Increased latency from third-party dependency (payments-gateway)'}</p><a href={edge?'#reliability':'#edge'}>Open {edge?'Reliability Room':'Edge Watch'}<ArrowRight size={14}/></a></>}</div>}
    </section></ChartTooltip>}
  </div>;
}

if(!getWidgetDefinition('plugin','reference-timeseries'))registerWidgetPlugin({id:'reference-timeseries',label:'Reference time series',description:'An authored concept reconstruction with exact reference geometry and keyboard inspection',dataKind:'metrics',render:ReferenceChartRenderer,parseConfig:config=>referenceChartConfig.parse(config),styleControls:['tooltips']});

export function ReferenceTimeseries({kind,service='uptime-api',gateway='edge-01',phase=0,panel}:{kind:Kind;service?:string;gateway?:string;phase?:number;panel?:{title:string;info?:string;className?:string;actions?:ReactNode}}) {
  const result=useMemo(()=>makeReferenceResult(kind,service,phase,gateway),[kind,service,phase,gateway]);
  const title=panel?.title??(kind==='edge'?'Network traffic':'Availability burn rate');
  const source=useMemo<Widget>(()=>({id:`reference-${kind}`,title,type:'plugin',pluginId:'reference-timeseries',dataKind:'metrics',providerId:'reference-fixture',query:`reference.${kind}`,unit:kind==='edge'?'Mb/s':'x',layout:{x:0,y:0,w:8,h:4},config:{kind,service,gateway,phase}}),[kind,service,gateway,phase,title]);
  const panels=useDashboardPanels(), selection={kind,service,gateway,phase};
  const widget=panels.current(source,selection), actions=panels.actions({widget:source,result},selection);
  const chart=<WidgetVisualization widget={widget} result={result}/>;
  return panel?<RefPanel title={widget.title} info={panel.info} className={panel.className} action={<div className="dashboard-reference-actions">{panel.actions}{actions}</div>}>{chart}</RefPanel>:<>{actions}{chart}</>;
}
