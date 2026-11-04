import { restoreTooltipFocus } from '@insights/tooltip-focus';
import { useTooltipDismiss } from '../../renderer-extensions/use-tooltip-dismiss';
import { ChartTooltip } from '../../renderer-extensions/chart-tooltip';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { area, line } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import { X } from 'lucide-react';
import type { WidgetRendererProps } from '@insights/widget-registry';
import { useChartTimeWindow, useTimeWindowBrush } from '@insights/chart-window-controls';
import { LabWindowControls } from '../../renderer-extensions/lab-window-controls';
import { nearestTimeIndex } from '@insights/time-window';
import { temporalPosition } from '@insights/chart-presentation';
import { validTimestamp } from '@insights/widget-context';
import { useLabMotion } from '../../components/lab/motion';
import { forecastBandConfig, forecastRecords, type ForecastPoint } from './grid-model';
import './grid-charts.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

const clock=(timestamp:number)=>new Date(timestamp).toISOString().slice(11,16);
const value=(n:number|null)=>n===null?'Unknown':n.toLocaleString('en-US',{maximumFractionDigits:1});

export function ForecastBands({widget,result,embedded,onContextChange}:WidgetRendererProps) {
  const config=useMemo(()=>forecastBandConfig.parse(widget.config??{}),[widget.config]);
  const data=useMemo(()=>{
    const parsed=result.records?forecastRecords(result.records):{points:[],omitted:0};
    const points=parsed.points.filter(p=>validTimestamp(p.timestamp));
    return {points,omitted:parsed.omitted+parsed.points.length-points.length};
  },[result.records]);
  const {points}=data;
  const hasPoints=points.length>0;
  const extent=hasPoints?{start:points[0].timestamp,end:points.at(-1)!.timestamp}:null;
  const window=useChartTimeWindow(extent,result,600000);
  const [size,setSize]=useState({width:700,height:230}),[selected,setSelected]=useState<number|null>(null),[pinned,setPinned]=useState(false);
  const box=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),revision=useRef(result),uid=useId().replaceAll(':','');
  const inspectable=!embedded&&widget.options?.showTooltip!==false;
  const {reduced}=useLabMotion();
  const unit=widget.unit;
  const entering=useChartEntrance({disabled:embedded,anchor:box});
  const hoverDismiss=useTooltipDismiss({onDismiss:()=>setSelected(null),pinned,revision:result,enabled:inspectable});
  useEffect(()=>{const element=svg.current;if(!element)return;const measure=()=>{const bounds=element.getBoundingClientRect(),w=bounds.width,h=bounds.height;if(w&&h)setSize(p=>p.width===w&&p.height===h?p:{width:w,height:h});};const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[hasPoints]);
  useEffect(()=>{if(revision.current!==result){revision.current=result;setSelected(null);setPinned(false);}},[result]);
  useEffect(()=>{if(!inspectable){setSelected(null);setPinned(false);}},[inspectable]);
  useEffect(()=>{if(selected!==null&&(selected<window.window.start||selected>window.window.end)){setSelected(null);setPinned(false);}},[window.window.start,window.window.end,selected]);
  const margin={left:49,right:14,top:13,bottom:26},pw=Math.max(1,size.width-margin.left-margin.right),ph=Math.max(1,size.height-margin.top-margin.bottom);
  const yScale=scaleLinear().domain([0,Math.max(1,...points.flatMap(p=>[p.observed??0,p.high95??0,p.capacity??0]))]).nice(5);
  const ymax=yScale.domain()[1];
  const x=(timestamp:number)=>temporalPosition(timestamp,window.window.start,window.window.end,margin.left,margin.left+pw);
  const y=(v:number)=>margin.top+ph-v/ymax*ph;
  const path=(key:'observed'|'median'|'capacity')=>line<ForecastPoint>().defined(p=>p[key]!==null&&p[key]!==undefined).x(p=>x(p.timestamp)).y(p=>y(p[key]!))(points)??'';
  const band=(low:'low68'|'low95',high:'high68'|'high95')=>area<ForecastPoint>().defined(p=>p[low]!==null&&p[high]!==null).x(p=>x(p.timestamp)).y0(p=>y(p[low]!)).y1(p=>y(p[high]!))(points)??'';
  const point=(clientX:number,clientY:number)=>{const matrix=svg.current?.getScreenCTM();if(!matrix)return null;const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());return{x:p.x,y:p.y,timestamp:window.window.start+(Math.max(margin.left,Math.min(margin.left+pw,p.x))-margin.left)/pw*(window.window.end-window.window.start),inPlot:p.x>=margin.left&&p.x<=margin.left+pw&&p.y>=margin.top&&p.y<=margin.top+ph};};
  const brush=useTimeWindowBrush({enabled:!embedded&&window.enabled,revision:result,window:window.window,point,commit:window.commit,onStart:()=>{hoverDismiss.cancel();setSelected(null);setPinned(false);}});
  const timed=useMemo(()=>points.map(p=>({timestamp:p.timestamp,value:p.observed??p.median})),[points]);
  // Keep hooks unconditional so an empty response can recover in the same
  // mounted widget. Missing-valued rows still carry a real time domain.
  if(!hasPoints)return <div className="grid-forecast" data-motion={reduced?'reduced':'auto'}><p className="grid-chart-empty" role="status">No forecast observations</p>{data.omitted>0&&<p className="grid-chart-note">{data.omitted} records with invalid time omitted.</p>}</div>;
  function inspect(timestamp:number,pin:boolean){if(!inspectable)return;const index=nearestTimeIndex(timed,timestamp,window.window);if(index===null)return;const p=points[index];hoverDismiss.cancel();setSelected(p.timestamp);if(pin){setPinned(true);onContextChange?.({series:p.observed!==null?'Observed':'Forecast median',value:p.observed??p.median,labels:{timestamp:String(p.timestamp),kind:p.observed!==null?'observation':'forecast',interval68:p.low68===null?'unknown':`${p.low68}–${p.high68}`,interval95:p.low95===null?'unknown':`${p.low95}–${p.high95}`}});}}
  function dismiss(){hoverDismiss.cancel();setSelected(null);setPinned(false);restoreTooltipFocus(svg.current);}
  const active=revision.current===result&&inspectable?points.find(p=>p.timestamp===selected&&p.timestamp>=window.window.start&&p.timestamp<=window.window.end):undefined,issue=points.find(p=>p.median!==null)?.timestamp;
  const ticks=window.window.start===window.window.end?[window.window.start]:Array.from({length:size.width<420?4:7},(_,i)=>window.window.start+i/(size.width<420?3:6)*(window.window.end-window.window.start));
  return <div className="grid-forecast" onPointerLeave={hoverDismiss.schedule} data-forecast-window-start={window.window.start} data-forecast-window-end={window.window.end} data-motion={reduced?'reduced':'auto'} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))hoverDismiss.schedule();}}>
    {widget.options?.showLegend!==false&&<div className="grid-forecast-key"><span><i style={{background:'var(--gamma-chart-1)'}}/>Observed</span><span><i className="is-dashed" style={{borderColor:'var(--gamma-chart-2)'}}/>Forecast median</span>{config.show68&&<span><i style={{background:'var(--gamma-chart-2)',opacity:.3}}/>68% range</span>}{config.show95&&<span><i style={{background:'var(--gamma-chart-6)',opacity:.25}}/>95% range</span>}{config.showCapacity&&points.some(p=>p.capacity!=null)&&<span><i className="is-dashed" style={{borderColor:'var(--gamma-warning)'}}/>Available supply</span>}</div>}
    <div className="grid-forecast-canvas" ref={box} data-chart-entering={entering||undefined}>
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label={`${widget.title}. UTC time; ${unit}. Drag horizontally to zoom. Arrow keys inspect; Enter pins; Escape closes.`} tabIndex={inspectable?0:undefined} {...brush.handlers} onPointerMove={event=>{if(pinned||brush.active||!inspectable)return;const p=point(event.clientX,event.clientY);if(p?.inPlot)inspect(p.timestamp,false);else hoverDismiss.schedule();}} onClick={event=>{const p=point(event.clientX,event.clientY);if(p?.inPlot)inspect(p.timestamp,true);}} onKeyDown={event=>{if(!inspectable)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();return;}if(event.key==='Enter'){if(selected!==null)inspect(selected,true);return;}if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const visible=points.filter(p=>p.timestamp>=window.window.start&&p.timestamp<=window.window.end);const i=visible.findIndex(p=>p.timestamp===selected);const n=Math.max(0,Math.min(visible.length-1,(i<0?0:i)+(event.key==='ArrowRight'?1:-1)));setPinned(false);inspect(visible[n].timestamp,false);}}}>
        <defs><clipPath id={`${uid}-forecast-clip`}><rect x={margin.left} y={margin.top} width={pw} height={ph}/></clipPath><PlotHatchDefs id={uid}/></defs>
        {yScale.ticks(5).map(v=><g key={v}>{config.showGrid&&<line x1={margin.left} x2={margin.left+pw} y1={y(v)} y2={y(v)} stroke="var(--gamma-border)"/>}<text x={margin.left-9} y={y(v)+4} textAnchor="end" fill="var(--gamma-muted)" fontSize="11">{v.toLocaleString()}</text></g>)}
        {ticks.map((t,i)=><g key={t}>{config.showGrid&&<line x1={x(t)} x2={x(t)} y1={margin.top} y2={margin.top+ph} stroke="var(--gamma-border)"/>}<text x={x(t)} y={size.height-7} textAnchor={i===0?'start':i===ticks.length-1?'end':'middle'} fill="var(--gamma-muted)" fontSize="11">{clock(t)}</text></g>)}
        <g clipPath={`url(#${uid}-forecast-clip)`}>
          {issue!==undefined&&<><rect x={x(issue)} y={margin.top} width={Math.max(0,x(points.at(-1)!.timestamp)-x(issue))} height={ph} fill="var(--gamma-chart-2)" opacity=".045"/><line x1={x(issue)} x2={x(issue)} y1={margin.top} y2={margin.top+ph} stroke="var(--gamma-muted)" strokeDasharray="4 4"/><text x={x(issue)+8} y={margin.top+13} fill="var(--gamma-chart-2)" fontSize="10">Forecast →</text></>}
          <g className={chartEntrance.revealMarks}>{points.map((p,i)=>p.observed===null&&p.median===null&&points[i+1]?<rect key={p.timestamp} x={x(p.timestamp)} y={margin.top} width={Math.max(1,x(points[i+1].timestamp)-x(p.timestamp))} height={ph} fill={plotHatchFill(uid)}/>:null)}
          {config.show95&&<path d={band('low95','high95')} fill="var(--gamma-chart-6)" fillOpacity=".23"/>}{config.show68&&<path d={band('low68','high68')} fill="var(--gamma-chart-2)" fillOpacity=".3"/>}
          {config.showCapacity&&<path d={path('capacity')} fill="none" stroke="var(--gamma-warning)" strokeWidth="1.6" strokeDasharray="3 4"/>}
          <path d={path('observed')} fill="none" stroke="var(--gamma-chart-1)" strokeWidth="1.65"/><path d={path('median')} fill="none" stroke="var(--gamma-chart-2)" strokeWidth="1.8" strokeDasharray="5 4"/>
          {active&&<><line x1={x(active.timestamp)} x2={x(active.timestamp)} y1={margin.top} y2={margin.top+ph} stroke="var(--gamma-ink)" strokeDasharray="4 4"/>{(active.observed??active.median)!==null&&<circle cx={x(active.timestamp)} cy={y((active.observed??active.median)!)} r="4.5" fill={active.observed!==null?'var(--gamma-chart-1)':'var(--gamma-chart-2)'} stroke="var(--gamma-bg)" strokeWidth="1.8"/>}</>}</g>
          {brush.preview&&<rect x={Math.min(brush.preview.x1,brush.preview.x2)} y={margin.top} width={Math.abs(brush.preview.x2-brush.preview.x1)} height={ph} fill="var(--gamma-chart-1)" fillOpacity=".16" stroke="var(--gamma-chart-1)"/>}
        </g>
      </svg>
      {inspectable&&active&&<ChartTooltip pinned={pinned} onClose={dismiss} onLeave={hoverDismiss.schedule}><section className="grid-forecast-inspector" aria-label="Forecast observation details" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}}}><header><strong>{new Date(active.timestamp).toISOString().slice(0,10)} · {clock(active.timestamp)} UTC</strong><button aria-label="Close forecast inspection" onClick={dismiss}><X size={12}/></button></header><dl>{active.observed!==null?<div><dt>Observed value</dt><dd>{value(active.observed)} {unit}</dd></div>:active.median===null?<div><dt>Observed value</dt><dd>No telemetry</dd></div>:<><div><dt>Forecast median</dt><dd>{value(active.median)} {unit}</dd></div><div><dt>68% interval</dt><dd>{value(active.low68)}–{value(active.high68)} {unit}</dd></div><div><dt>95% interval</dt><dd>{value(active.low95)}–{value(active.high95)} {unit}</dd></div></>}{active.capacity!=null&&<><div><dt>Available supply</dt><dd>{value(active.capacity)} {unit}</dd></div><div><dt>Reserve vs selected</dt><dd>{value((active.observed??active.median)===null?null:active.capacity-(active.observed??active.median)!)} {unit}</dd></div></>}</dl><footer><span>{pinned?'Pinned observation':'Exact observation'}</span><button onClick={()=>{hoverDismiss.cancel();setPinned(v=>!v);}}>{pinned?'Unpin':'Pin'}</button></footer></section></ChartTooltip>}
    </div>
    {!embedded&&extent&&extent.end>extent.start&&<LabWindowControls state={window}/>}
    {data.omitted>0&&<p className="grid-chart-note">{data.omitted} records with invalid time omitted.</p>}
  </div>;
}
