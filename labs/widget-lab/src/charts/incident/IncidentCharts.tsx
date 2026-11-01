import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { area, line } from 'd3-shape';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { ChevronDown, ChevronRight, Crosshair, Search, X } from 'lucide-react';
import { Sparkline } from '../../components/lab/StudyPrimitives';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { useChartCursorPublisher } from '../../vendor/paprika/ui/src/features/insights/chart-cursor';
import { minimumTimeWindow, nearestTimeIndex, timeWindowExtent } from '../../vendor/paprika/ui/src/features/insights/time-window';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../../vendor/paprika/ui/src/features/insights/time-window-controls';
import { alignedTelemetryConfig, buildDependencyGraph, buildTraceSpans, dependencyConfig, telemetryAt, traceWaterfallConfig, visibleTraceSpans } from './incident-model';
import './IncidentCharts.css';

function useWidth(ref: RefObject<HTMLDivElement | null>, fallback = 720) {
  const [width,setWidth] = useState(fallback);
  useEffect(() => { const node=ref.current;if(!node)return;const measure=()=>{if(node.clientWidth>0)setWidth(node.clientWidth);};const observer=new ResizeObserver(measure);observer.observe(node);measure();return()=>observer.disconnect();},[ref]);
  return width;
}
const utc = (time:number) => new Date(time).toISOString().slice(11,19);
const compact = (n:number) => Math.abs(n)>=1000 ? `${Number((n/1000).toFixed(1))}k` : `${Number(n.toFixed(1))}`;
const statusColor = (status:string) => status==='ERROR'?'var(--gamma-danger)':status==='OK'?'var(--gamma-success)':'var(--gamma-muted)';

export function AlignedTelemetry({widget,result,embedded,onContextChange}:WidgetRendererProps) {
  const config=useMemo(()=>alignedTelemetryConfig.parse(widget.config),[widget.config]);
  const series=result.series??[];
  const wrapper=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),width=useWidth(wrapper),uid=useId().replaceAll(':','');
  const publisher=useChartCursorPublisher();
  const [selected,setSelected]=useState<number|null>(null),[pinned,setPinned]=useState(false);
  const extent=useMemo(()=>timeWindowExtent(series),[series]);
  const minimum=useMemo(()=>extent?minimumTimeWindow(series,extent):1,[series,extent]);
  const windowState=useChartTimeWindow(extent,result,minimum);
  const timestamps=useMemo(()=>[...new Set(series.flatMap(entry=>entry.points.map(point=>point.timestamp)))].sort((a,b)=>a-b),[series]);
  const eligible=timestamps.filter(time=>time>=windowState.window.start&&time<=windowState.window.end);
  const plot={left:46,right:12,width:Math.max(80,width-58)};
  const laneStride=config.laneHeight+29,plotBottom=config.tracks.length*laneStride;
  const eventHeight=config.showEvents&&config.events.length?43:0,height=plotBottom+26+eventHeight;
  const x=scaleLinear().domain([windowState.window.start,windowState.window.end]).range([plot.left,width-plot.right]);
  const ticks=scaleUtc().domain([new Date(windowState.window.start),new Date(windowState.window.end)]).ticks(Math.max(2,Math.min(7,Math.floor(plot.width/90))));
  const interactive=!embedded&&widget.options?.showTooltip!==false;
  const clear=()=>{setSelected(null);setPinned(false);publisher.clear(widget.id);};
  const dismiss=()=>{clear();svg.current?.focus({preventScroll:true});};
  useEffect(()=>{clear();},[result,windowState.window.start,windowState.window.end,interactive]);
  useEffect(()=>{if(selected!==null)publisher.publish(widget.id,selected,pinned);else publisher.clear(widget.id);return()=>publisher.clear(widget.id);},[selected,pinned,publisher,widget.id]);
  const point=(clientX:number,clientY:number)=>{const matrix=svg.current?.getScreenCTM();if(!matrix)return null;const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());return{x:Math.max(plot.left,Math.min(width-plot.right,p.x)),y:p.y,timestamp:x.invert(Math.max(plot.left,Math.min(width-plot.right,p.x))),inPlot:p.x>=plot.left&&p.x<=width-plot.right&&p.y>=21&&p.y<=plotBottom};};
  const brush=useTimeWindowBrush({enabled:!embedded&&windowState.enabled,revision:result,window:windowState.window,point,commit:windowState.commit,onStart:clear});
  const inspect=(timestamp:number,pin=false)=>{if(!interactive)return;setSelected(timestamp);setPinned(pin);if(pin)onContextChange?.({series:'Aligned telemetry',labels:{timestamp:new Date(timestamp).toISOString(),service:series[0]?.labels.service??''}});};
  const pointer=(event:{clientX:number;clientY:number},pin=false)=>{if(!interactive||brush.active||(pinned&&!pin))return;const p=point(event.clientX,event.clientY);if(!p?.inPlot)return;const index=nearestTimeIndex(eligible.map(timestamp=>({timestamp,value:0})),p.timestamp);if(index!==null)inspect(eligible[index],pin);};
  const exact=selected===null?[]:telemetryAt(series,selected);
  if(!series.length)return <div className="incident-empty">No telemetry in this result.</div>;
  return <div ref={wrapper} className="aligned-telemetry" data-shared-window-start={windowState.window.start} data-shared-window-end={windowState.window.end} onPointerLeave={()=>{if(!pinned&&!brush.active)clear();}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)&&!pinned)clear();}} onKeyDown={event=>{if(event.key==='Escape'&&selected!==null){event.preventDefault();event.stopPropagation();dismiss();}}}>
    {!embedded&&<TimeWindowControls state={windowState} compact/>}
    <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={widget.title} aria-description="Separate units share the same UTC time axis. Drag any lane to zoom all lanes; Time window offers exact input, Undo and Reset. Arrow keys inspect, Enter pins, Escape closes." tabIndex={embedded?-1:0} {...brush.handlers} onPointerMove={event=>pointer(event)} onClick={event=>pointer(event,true)} onKeyDown={event=>{
      if(!interactive)return;
      if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const current=selected===null?0:Math.max(0,eligible.indexOf(selected));const index=event.key==='Home'?0:event.key==='End'?eligible.length-1:Math.max(0,Math.min(eligible.length-1,current+(event.key==='ArrowRight'?1:-1)));if(eligible[index]!==undefined)inspect(eligible[index]);}
      else if(event.key==='Enter'||event.key===' '){event.preventDefault();const stamp=selected??eligible[Math.floor(eligible.length/2)];if(stamp!==undefined)inspect(stamp,!pinned);}
    }} style={{touchAction:'pan-y',userSelect:'none'}}>
      <defs><pattern id={`${uid}-missing`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><line x1="0" x2="0" y1="0" y2="6" stroke="var(--gamma-muted)" strokeOpacity=".24" strokeWidth="1"/></pattern></defs>
      {config.tracks.map((track,index)=>{
        const entry=series.find(item=>item.name===track.name),points=entry?.points??[];
        const top=index*laneStride+23,bottom=top+config.laneHeight;
        const maximum=Math.max(track.maximum??1,...points.map(p=>p.value??0))*1.03;
        const y=scaleLinear().domain([0,maximum]).range([bottom,top]);
        const path=line<(typeof points)[number]>().defined(p=>p.value!==null).x(p=>x(p.timestamp)).y(p=>y(p.value!))(points)??'';
        const fill=area<(typeof points)[number]>().defined(p=>p.value!==null).x(p=>x(p.timestamp)).y0(y(0)).y1(p=>y(p.value!))(points)??'';
        const value=exact.find(item=>item.name===track.name)?.value;
        const gaps:Array<{start:number;end:number}>=[];let gap:number|null=null;
        points.forEach((p,i)=>{if(p.value===null&&gap===null)gap=p.timestamp;if(gap!==null&&(p.value!==null||i===points.length-1)){gaps.push({start:gap,end:p.timestamp});gap=null;}});
        return <g key={track.name} data-telemetry-lane={track.name}><defs><clipPath id={`${uid}-lane-${index}`}><rect x={plot.left} y={top} width={plot.width} height={config.laneHeight}/></clipPath><linearGradient id={`${uid}-fill-${index}`} x1="0" y1="0" x2="0" y2="1"><stop stopColor={track.color} stopOpacity=".24"/><stop offset="1" stopColor={track.color} stopOpacity=".02"/></linearGradient></defs>
          <text x="2" y={top-8} className="incident-svg-title">{track.label}<tspan className="incident-svg-muted">  {track.unit}</tspan></text>
          {selected!==null&&<text x={width-12} y={top-8} textAnchor="end" fill={track.color}>{value===null||value===undefined?'No telemetry':`${value.toFixed(track.decimals)} ${track.unit}`}</text>}
          {[0,maximum/2,maximum].map(v=><g key={v}><line x1={plot.left} x2={width-plot.right} y1={y(v)} y2={y(v)} className="incident-gridline"/><text x={plot.left-8} y={y(v)+4} textAnchor="end" className="incident-svg-muted">{compact(v)}</text></g>)}
          {ticks.map(tick=><line key={+tick} x1={x(+tick)} x2={x(+tick)} y1={top} y2={bottom} className="incident-gridline"/>)}
          <g clipPath={`url(#${uid}-lane-${index})`}>
            {(config.showEvents?config.events:[]).filter(event=>event.kind==='incident').map(event=><rect key={event.id} x={x(event.start)} y={top} width={Math.max(1,x(event.end??event.start)-x(event.start))} height={config.laneHeight} fill="var(--gamma-danger)" opacity=".055"/>)}
            {gaps.map((g,i)=><g key={i}><rect x={x(g.start)} y={top} width={Math.max(0,x(g.end)-x(g.start))} height={config.laneHeight} fill={`url(#${uid}-missing)`}/>{x(g.end)-x(g.start)>65&&<text x={(x(g.start)+x(g.end))/2} y={top+config.laneHeight/2} textAnchor="middle" className="incident-svg-muted">No telemetry</text>}</g>)}
            {config.showFill&&<path d={fill} fill={`url(#${uid}-fill-${index})`}/>}<path d={path} fill="none" stroke={track.color} strokeWidth={config.lineWidth} vectorEffect="non-scaling-stroke"/>
            {selected!==null&&<><line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="#d6eef4" strokeDasharray="4 3"/>{value!==null&&value!==undefined&&<circle cx={x(selected)} cy={y(value)} r={4} fill={track.color} stroke="#edfaff" strokeWidth="1.5"/>}</>}
            {brush.preview&&<rect x={Math.min(brush.preview.x1,brush.preview.x2)} y={top} width={Math.abs(brush.preview.x2-brush.preview.x1)} height={config.laneHeight} fill="#7ac9e0" fillOpacity=".15" stroke="#a9dbe8" strokeDasharray="3 2"/>}
          </g>
        </g>;
      })}
      {ticks.map(tick=><text key={+tick} x={x(+tick)} y={plotBottom+12} textAnchor="middle" className="incident-svg-muted">{tick.toISOString().slice(11,windowState.window.end-windowState.window.start<300_000?19:16)}</text>)}
      {config.showEvents&&['deployment','incident'].map((kind,row)=><g key={kind}><text x="2" y={plotBottom+32+row*20} className="incident-svg-muted">{kind==='deployment'?'Deploy':'Incident'}</text><line x1={plot.left} x2={width-plot.right} y1={plotBottom+28+row*20} y2={plotBottom+28+row*20} className="incident-gridline"/>{config.events.filter(e=>e.kind===kind&&e.start<=windowState.window.end&&(e.end??e.start)>=windowState.window.start).map(event=>{const left=x(Math.max(event.start,windowState.window.start)),end=x(Math.min(event.end??event.start,windowState.window.end));return <g key={event.id}><rect x={left} y={plotBottom+21+row*20} width={Math.max(4,end-left)} height={13} rx="1" fill={kind==='incident'?'#c44f5a':'#15b9a7'} opacity={kind==='incident'?.65:.9}/>{width>460&&<text x={Math.min(left+8,width-145)} y={plotBottom+32+row*20} fill="#e0eff4">{event.label}</text>}<title>{event.label} · {utc(event.start)} UTC{event.end?` – ${utc(event.end)}`:''}</title></g>;})}</g>)}
    </svg>
    {widget.options?.showLegend!==false&&<div className="incident-chart-legend">{config.tracks.map(track=><span key={track.name}><i style={{background:track.color}}/>{track.label} <small>{track.unit}</small></span>)}<span><i className="is-hatched"/>Unknown</span><span className="incident-utc">UTC · 10s source samples</span></div>}
    {interactive&&selected!==null&&<section className="incident-time-inspector" aria-label="Aligned telemetry details"><header><strong>{pinned?'Pinned':'Inspecting'} · {utc(selected)} UTC</strong><button onClick={dismiss} aria-label="Close telemetry details"><X size={13}/></button></header><div>{config.tracks.map(track=>{const value=exact.find(item=>item.name===track.name)?.value;return <article key={track.name}><span style={{color:track.color}}>{track.label}</span><strong>{value===null||value===undefined?'No telemetry':`${value.toFixed(track.decimals)} ${track.unit}`}</strong><div className="incident-mini-history"><Sparkline values={(series.find(s=>s.name===track.name)?.points??[]).map(p=>p.value)} color={track.color} height={30}/></div></article>;})}</div><footer>{series[0]?.labels.service} · exact same-time samples<button onClick={()=>setPinned(!pinned)}>{pinned?'Unpin observation':'Pin observation'}</button></footer></section>}
  </div>;
}

export function TraceWaterfall({widget,result,embedded,onContextChange}:WidgetRendererProps) {
  const config=useMemo(()=>traceWaterfallConfig.parse(widget.config??{}),[widget.config]);
  const data=useMemo(()=>result.records?buildTraceSpans(result.records,config):null,[result.records,config]);
  const [search,setSearch]=useState(''),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[selected,setSelected]=useState<string|null>(null),[tab,setTab]=useState<'attributes'|'timing'>('attributes');
  const container=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),measured=useWidth(container),uid=useId().replaceAll(':','');
  const spanRefs=useRef(new Map<string,SVGGElement>());
  const interactive=!embedded&&widget.options?.showTooltip!==false;
  const extent=useMemo(()=>data&&data.duration>0?{start:0,end:data.duration}:null,[data]);
  const time=useChartTimeWindow(extent,result,1);
  useEffect(()=>{setSelected(null);setCollapsed(new Set());},[result]);
  const rows=useMemo(()=>visibleTraceSpans(data?.spans??[],collapsed,search),[data,collapsed,search]);
  useEffect(()=>{if(!interactive||(selected!==null&&!rows.some(span=>span.id===selected)))setSelected(null);},[interactive,rows,selected]);
  const selectedSpan=data?.byId.get(selected??'');
  const dismiss=()=>{const target=selected?spanRefs.current.get(selected):null;setSelected(null);(target??svg.current)?.focus({preventScroll:true});};
  const width=Math.max(620,measured),labelWidth=width>850?285:235,top=29,height=top+rows.length*config.rowHeight+5;
  const x=scaleLinear().domain([time.window.start,time.window.end]).range([labelWidth,width-62]);
  const tickValues=x.ticks(Math.max(3,Math.floor((width-labelWidth)/90)));
  const point=(clientX:number,clientY:number)=>{const matrix=svg.current?.getScreenCTM();if(!matrix)return null;const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());const px=Math.max(labelWidth,Math.min(width-62,p.x));return{x:px,y:p.y,timestamp:x.invert(px),inPlot:p.x>=labelWidth&&p.x<=width-62&&p.y>=top&&p.y<=height};};
  const brush=useTimeWindowBrush({enabled:!embedded,revision:result,window:time.window,point,commit:time.commit,onStart:()=>{}});
  const select=(id:string)=>{if(!interactive)return;setSelected(id);const span=data?.byId.get(id);if(span)onContextChange?.({series:span.operation,value:span.duration,labels:{spanId:span.id,traceId:span.traceId,service:span.service,status:span.status,startMs:String(span.start),durationMs:String(span.duration)}});};
  const focusSelected=()=>{if(!selectedSpan)return;const margin=Math.max(20,selectedSpan.duration*.15);time.commit({start:Math.max(0,selectedSpan.start-margin),end:Math.min(data!.duration,selectedSpan.end+margin)});};
  if(!data?.spans.length)return <div className="incident-empty">No trace spans in this result.</div>;
  return <div className="incident-trace" data-trace-duration={data.duration} onKeyDown={event=>{if(event.key==='Escape'&&selected!==null){event.preventDefault();event.stopPropagation();dismiss();}}}>
    {!embedded&&<div className="incident-trace-toolbar"><label><Search size={13}/><input aria-label="Search trace spans" placeholder="Search spans, services, status…" value={search} onChange={event=>setSearch(event.target.value)}/></label><span>{data.spans.length} spans · {data.duration.toLocaleString()}ms elapsed</span><button disabled={!selectedSpan} onClick={focusSelected}><Crosshair size={12}/>Focus selected</button>{time.canUndo&&<button onClick={time.undo}>Undo zoom</button>}<button onClick={time.reset} disabled={!time.zoomed}>Fit trace</button></div>}
    <div className="incident-trace-layout" data-inspecting={interactive&&!!selectedSpan}>
      <div ref={container} className="incident-trace-scroll" tabIndex={0} aria-label="Trace span timeline; scroll horizontally at narrow widths">
        <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={widget.title} {...brush.handlers} onClick={event=>{if(event.target!==event.currentTarget||!interactive)return;const p=point(event.clientX,event.clientY);if(!p?.inPlot)return;const span=rows[Math.floor((p.y-top+4)/config.rowHeight)];if(span)select(span.id);}} style={{touchAction:'pan-y',userSelect:'none'}} tabIndex={-1}>
          <defs><clipPath id={`${uid}-traceclip`}><rect x={labelWidth} y={top-7} width={width-labelWidth-62} height={height-top+7}/></clipPath></defs>
          <text x="3" y="13" className="incident-svg-muted">Service / span</text><text x={labelWidth-13} y="13" textAnchor="end" className="incident-svg-muted">ms</text>
          {tickValues.map(tick=><g key={tick}><line x1={x(tick)} x2={x(tick)} y1={top-10} y2={height} className="incident-gridline"/><text x={x(tick)} y="13" textAnchor="middle" className="incident-svg-muted">{Math.round(tick)}</text></g>)}
          {rows.map((span,index)=>{const y=top+index*config.rowHeight,active=span.id===selected,indent=Math.min(span.depth*12,labelWidth-130),color=span.status==='ERROR'?'#f4787d':span.service.includes('payment')?'#a289f5':'#13c7df';return <g key={span.id} className="incident-span-row" data-selected={active}>
            <rect x="0" y={y-4} width={width} height={config.rowHeight} fill={active?'#103e4b':index%2===0?'#0a2029':'transparent'} stroke={active?'#24667a':'none'}/>
            {span.children.length>0&&!embedded&&<g role="button" tabIndex={0} aria-label={`${collapsed.has(span.id)?'Expand':'Collapse'} ${span.operation}`} aria-expanded={!collapsed.has(span.id)} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);if(next.has(span.id))next.delete(span.id);else next.add(span.id);return next;})} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setCollapsed(previous=>{const next=new Set(previous);if(next.has(span.id))next.delete(span.id);else next.add(span.id);return next;});}}}><rect x={indent} y={y-2} width="20" height="21" fill="transparent"/>{collapsed.has(span.id)?<ChevronRight x={indent+2} y={y+1} size={12}/>:<ChevronDown x={indent+2} y={y+1} size={12}/>}</g>}
            <g ref={element=>{if(element)spanRefs.current.set(span.id,element);else spanRefs.current.delete(span.id);}} role={interactive?'button':'img'} tabIndex={interactive?0:undefined} aria-label={`Inspect span ${span.operation}, ${span.duration} milliseconds, ${span.status}`} aria-pressed={interactive?active:undefined} onClick={()=>select(span.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(span.id);}}}>
              <rect x={indent+20} y={y-4} width={Math.max(1,width-indent-20)} height={config.rowHeight} fill="transparent"/>
              <defs><clipPath id={`${uid}-label-${index}`}><rect x={indent+20} y={y-4} width={Math.max(1,labelWidth-indent-65)} height={config.rowHeight}/></clipPath></defs>
              <text x={indent+22} y={y+12} className="incident-span-label" clipPath={`url(#${uid}-label-${index})`}>{span.operation.length>25?`${span.operation.slice(0,24)}…`:span.operation}</text><text x={labelWidth-15} y={y+12} textAnchor="end" className="incident-svg-muted">{span.duration}</text>
              <g clipPath={`url(#${uid}-traceclip)`}><rect x={x(span.start)} y={y+1} width={Math.max(1,x(span.end)-x(span.start))} height={config.rowHeight-12} rx="1" fill={color} opacity={active?1:.84} stroke={active?'#f8fcff':'none'} strokeWidth="1.5"/>{span.parentId&&<path d={`M${x(data.byId.get(span.parentId)!.start)} ${y-5} V${y+8} H${x(span.start)}`} stroke="#527984" strokeDasharray="2 2" fill="none" opacity=".7"/>}</g>
              <title>{config.showService?`${span.service} · `:''}{span.operation} · {span.start}–{span.end}ms · {span.status}</title>
            </g>
          </g>;})}
          {brush.preview&&<rect x={Math.min(brush.preview.x1,brush.preview.x2)} y={top-9} width={Math.abs(brush.preview.x2-brush.preview.x1)} height={height-top+9} fill="#89cddd" fillOpacity=".15" stroke="#bfdce9"/>}
        </svg>
        {rows.length===0&&<div className="incident-empty">No spans match this search.</div>}
      </div>
      {interactive&&selectedSpan&&<section className="incident-span-inspector" aria-label={`Span details for ${selectedSpan.operation}`}><header><strong><i style={{background:statusColor(selectedSpan.status)}}/>{selectedSpan.operation}</strong><button aria-label="Close span details" onClick={dismiss}><X size={14}/></button></header><div className="incident-span-big">{selectedSpan.duration.toLocaleString()}<span>ms</span><small>observed span duration</small></div><dl><div><dt>Service</dt><dd>{selectedSpan.service}</dd></div><div><dt>Status</dt><dd style={{color:statusColor(selectedSpan.status)}}>{selectedSpan.status}</dd></div><div><dt>Trace ID</dt><dd className="is-mono">{selectedSpan.traceId}</dd></div><div><dt>Span ID</dt><dd className="is-mono">{selectedSpan.id}</dd></div></dl><div className="incident-inspector-tabs"><button aria-pressed={tab==='attributes'} onClick={()=>setTab('attributes')}>Attributes</button><button aria-pressed={tab==='timing'} onClick={()=>setTab('timing')}>Timing</button></div>{tab==='attributes'?<dl><div><dt>Parent</dt><dd>{selectedSpan.parentId??'Root span'}</dd></div><div><dt>Children</dt><dd>{selectedSpan.children.length}</dd></div><div><dt>Fixture</dt><dd>Sampled request</dd></div></dl>:<dl><div><dt>Start offset</dt><dd>{selectedSpan.start}ms</dd></div><div><dt>End offset</dt><dd>{selectedSpan.end}ms</dd></div><div><dt>Share of elapsed</dt><dd>{data.duration>0?`${(selectedSpan.duration/data.duration*100).toFixed(2)}%`:'Unavailable · zero elapsed'}</dd></div></dl>}<p>Parallel spans overlap. Their durations are not added to obtain request latency.</p><button className="incident-inspector-action" onClick={focusSelected}><Crosshair size={13}/>Focus this interval</button></section>}
    </div><div className="incident-trace-note"><span>Offsets from request start · drag timeline to zoom · {Math.round(time.window.start)}–{Math.round(time.window.end)}ms</span><span>{result.records?.truncated?'Partial source trace':'One sampled request, not aggregate latency'}</span></div>
  </div>;
}

function dependencyLayout(data: ReturnType<typeof buildDependencyGraph>, width: number) {
  const degree = (name: string) => data.edges.filter(edge => edge.source === name || edge.target === name).length;
  const hub = [...data.nodes].sort((a,b) => degree(b.name)-degree(a.name) || b.requests-a.requests || a.name.localeCompare(b.name))[0];
  const positions = new Map<string,{x:number;y:number}>();
  if (!hub) return { positions, height:240, hub:null };
  const adjacent = (name:string) => [...new Set(data.edges.flatMap(edge => edge.source === name ? [edge.target] : edge.target === name ? [edge.source] : []))];
  const neighbours = adjacent(hub.name), neighbourSet = new Set(neighbours);
  if (neighbours.length <= 6 && data.nodes.length <= 12) {
    // Keep one hub, its first neighbours and the next dependency tier distinct.
    // Every position comes from connectivity; service names never assign geometry.
    const mid=width/2,edge=Math.min(46,width*.16);
    const slots=[{x:mid,y:25},{x:width-edge,y:90},{x:width-edge,y:174},{x:mid,y:174},{x:edge,y:174},{x:edge,y:90}];
    positions.set(hub.name,{x:mid,y:96});
    const taken = new Set<number>();
    const assign=(name:string,slot:number)=>{positions.set(name,slots[slot]);taken.add(slot);};
    const branch = neighbours.filter(name=>adjacent(name).some(other=>other!==hub.name&&!neighbourSet.has(other))).sort((a,b)=>degree(b)-degree(a)||a.localeCompare(b))[0];
    if(branch)assign(branch,3);
    const incoming=data.edges.filter(edge=>edge.target===hub.name&&!positions.has(edge.source)).sort((a,b)=>b.requests-a.requests||a.source.localeCompare(b.source))[0]?.source;
    if(incoming)assign(incoming,5);
    const order=[0,1,2,4,5,3];
    neighbours.filter(name=>!positions.has(name)).sort().forEach(name=>assign(name,order.find(slot=>!taken.has(slot))!));
    const remaining=data.nodes.filter(node=>!positions.has(node.name)).sort((a,b)=>{
      const ax=adjacent(a.name).map(name=>positions.get(name)?.x).find(value=>value!==undefined)??mid;
      const bx=adjacent(b.name).map(name=>positions.get(name)?.x).find(value=>value!==undefined)??mid;
      return ax-bx||a.name.localeCompare(b.name);
    });
    const columns=Math.max(2,Math.min(3,Math.floor(width/105)));
    remaining.forEach((node,index)=>{
      const row=Math.floor(index/columns),inRow=Math.min(columns,remaining.length-row*columns),column=index%columns;
      positions.set(node.name,{x:width*(column+1)/(inRow+1),y:260+row*78});
    });
    return {positions,height:remaining.length?310+(Math.ceil(remaining.length/columns)-1)*78:226,hub:hub.name};
  }
  // Dense/disconnected graphs keep fixed text and mark sizes. Their local scroll
  // region exposes all bounded source nodes instead of reducing the whole graph.
  const levels=new Map<string,number>([[hub.name,0]]),queue=[hub.name];
  for(let index=0;index<queue.length;index++)for(const next of adjacent(queue[index]))if(!levels.has(next)){levels.set(next,levels.get(queue[index])!+1);queue.push(next);}
  const remaining=data.nodes.filter(node=>node.name!==hub.name).sort((a,b)=>(levels.get(a.name)??Infinity)-(levels.get(b.name)??Infinity)||a.name.localeCompare(b.name));
  const columns=Math.max(2,Math.min(4,Math.floor(width/105)));
  positions.set(hub.name,{x:width/2,y:28});
  remaining.forEach((node,index)=>{const row=Math.floor(index/columns),inRow=Math.min(columns,remaining.length-row*columns);positions.set(node.name,{x:width*(index%columns+1)/(inRow+1),y:110+row*78});});
  return {positions,height:160+Math.max(0,Math.ceil(remaining.length/columns)-1)*78,hub:hub.name};
}

function dependencyLabel(name:string,width:number) {
  const characters=Math.max(9,Math.floor(Math.min(100,(width-24)/3)/5.5));
  if(name.length<=characters)return [name];
  const split=name.lastIndexOf('-',characters);
  const cut=split>characters*.45?split+1:characters;
  const tail=name.slice(cut);
  return [name.slice(0,cut),tail.length>characters?`${tail.slice(0,characters-1)}…`:tail];
}

export function ServiceDependency({widget,result,embedded,onContextChange}:WidgetRendererProps) {
  const config=useMemo(()=>dependencyConfig.parse(widget.config??{}),[widget.config]);
  const data=useMemo(()=>result.records?buildDependencyGraph(result.records,config):{nodes:[],edges:[]},[result.records,config]);
  const [selected,setSelected]=useState<string|null>(null);
  const uid=useId().replaceAll(':',''),svg=useRef<SVGSVGElement>(null),container=useRef<HTMLDivElement>(null);
  const measured=useWidth(container,300),width=Math.max(260,Math.round(measured));
  const layout=useMemo(()=>dependencyLayout(data,width),[data,width]);
  const {positions,height,hub}=layout;
  const nodeRefs=useRef(new Map<string,SVGGElement>());
  const interactive=!embedded&&widget.options?.showTooltip!==false;
  useEffect(()=>setSelected(null),[result]);
  useEffect(()=>{if(!interactive)setSelected(null);},[interactive]);
  const node=data.nodes.find(n=>n.name===selected);
  const select=(name:string)=>{if(!interactive)return;setSelected(name);const item=data.nodes.find(n=>n.name===name)!;onContextChange?.({series:name,value:item.errorRate,labels:{service:name,requests:String(item.requests),errors:String(item.errors)}});};
  const dismiss=()=>{const target=selected?nodeRefs.current.get(selected):null;setSelected(null);(target??svg.current)?.focus({preventScroll:true});};
  const colour=(rate:number|null)=>rate===null?'#7895a4':rate>5?'#f4787d':rate>1?'#f5bd56':'#16d6b0';
  if(!data.nodes.length)return <div className="incident-empty">No dependency edges in this result.</div>;
  return <div className="incident-dependency" onKeyDown={event=>{if(event.key==='Escape'&&selected!==null){event.preventDefault();event.stopPropagation();dismiss();}}}>
    <div ref={container} className="incident-dependency-graph" tabIndex={height>410?0:undefined} aria-label={height>410?'Service graph; scroll to see all services':undefined}>
      <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={widget.title} tabIndex={-1}>
        <defs><marker id={`${uid}-arrow`} viewBox="0 0 8 8" markerWidth="5" markerHeight="5" refX="7" refY="4" orient="auto-start-reverse"><path d="M0 1 L7 4 L0 7" fill="none" stroke="#88b9c6" strokeWidth="1.3"/></marker></defs>
        {data.edges.map(edge=>{
          const a=positions.get(edge.source)!,b=positions.get(edge.target)!,distance=Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),dx=(b.x-a.x)/distance,dy=(b.y-a.y)/distance;
          const related=!selected||edge.source===selected||edge.target===selected,bad=edge.errorRate!==null&&edge.errorRate>5;
          const sourceRadius=edge.source===hub?15:11,targetRadius=edge.target===hub?17:13;
          const sx=a.x+dx*sourceRadius,sy=a.y+dy*sourceRadius,tx=b.x-dx*targetRadius,ty=b.y-dy*targetRadius;
          const lx=(a.x+b.x)/2-dy*9,ly=(a.y+b.y)/2+dx*9;
          const latency=Number((edge.latency??0).toFixed(2));
          return <g key={edge.id} opacity={related?1:.18}>
            <path d={`M${sx},${sy} L${tx},${ty}`} fill="none" stroke={edge.errorRate===null?'#6b8490':bad?'#e9706e':'#5a9cab'} strokeWidth={bad?1.65:1} markerEnd={`url(#${uid}-arrow)`}/>
            {config.showLatency&&edge.latency!==null&&distance>48&&(data.nodes.length<=12||!!selected&&related)&&<g className="incident-edge-latency" aria-hidden="true"><rect x={lx-23} y={ly-8} width="46" height="14" rx="2"/><text x={lx} y={ly+3} textAnchor="middle" fill={bad?'#f59794':'#a3c9d4'}>{latency}ms</text></g>}
            <title>{edge.source} → {edge.target}; median {edge.latency===null?'unknown':`${edge.latency}ms`}; {edge.errors.toLocaleString()} errors / {edge.requests.toLocaleString()} requests</title>
          </g>;
        })}
        {data.nodes.map((n,index)=>{
          const p=positions.get(n.name)!,color=colour(n.errorRate),radius=n.name===hub?13:9,lines=dependencyLabel(n.name,width),labelWidth=Math.min(110,Math.max(...lines.map(line=>line.length))*5.5+8);
          return <g key={n.name} ref={element=>{if(element)nodeRefs.current.set(n.name,element);else nodeRefs.current.delete(n.name);}} transform={`translate(${p.x},${p.y})`} role={interactive?'button':'img'} tabIndex={interactive?0:undefined} aria-label={`Inspect service ${n.name}, ${n.errorRate===null?'error ratio unavailable; no observed calls':`${n.errorRate.toFixed(2)} percent errors`}`} aria-pressed={interactive?n.name===selected:undefined} onClick={()=>select(n.name)} onKeyDown={event=>{
            if(event.key==='Enter'||event.key===' '){event.preventDefault();select(n.name);}
            else if(event.key.startsWith('Arrow')){event.preventDefault();const next=data.nodes[Math.max(0,Math.min(data.nodes.length-1,index+(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)))];nodeRefs.current.get(next.name)?.focus();}
          }}>
            <circle r="20" fill="transparent"/>
            <circle className="incident-dependency-ring" r={radius} fill={color} fillOpacity=".16" stroke={color} strokeWidth="1.5"/>
            <circle r={radius-4} fill={color}/>
            {n.name===selected&&<circle r={radius+6} fill="none" stroke="var(--gamma-accent)" strokeWidth="1.5"/>}
            {config.showLabels&&<g pointerEvents="none"><rect x={-labelWidth/2} y="17" width={labelWidth} height={lines.length*12+3} rx="2" fill="var(--gamma-bg)" opacity=".95"/><text y="27" textAnchor="middle" className="incident-dependency-label">{lines.map((line,lineIndex)=><tspan x="0" dy={lineIndex?12:0} key={lineIndex}>{line}</tspan>)}</text></g>}
            <title>{n.name} · {n.requests.toLocaleString()} observed calls · {n.errors.toLocaleString()} failures</title>
          </g>;
        })}
      </svg>
    </div>
    {data.nodes.length>12&&<p className="incident-dependency-hint">{data.nodes.length} services · select a service for edge latencies · scroll for remaining nodes</p>}
    {interactive&&node&&<section className="incident-node-detail" aria-label={`Dependency details for ${node.name}`}><header><strong>{node.name}</strong><button aria-label="Close dependency details" onClick={dismiss}><X size={12}/></button></header><span>{node.requests.toLocaleString()} observed calls · {node.errors.toLocaleString()} failures</span><b style={node.errorRate===null?{color:'var(--gamma-muted)'}:undefined}>{node.errorRate===null?'Error ratio unavailable · no observed calls':`${node.errorRate.toFixed(2)}% error ratio`}</b><p>{node.incoming.length} upstream · {node.outgoing.length} downstream. Edge latency is the supplied median; direction denotes calls.</p></section>}
  </div>;
}
