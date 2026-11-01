import { restoreTooltipFocus } from '../../renderer-extensions/tooltip-focus';
import { useTooltipDismiss } from '../../components/lab/useTooltipDismiss';
import { ChartTooltip } from '../../components/lab/ChartTooltip';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { LocateFixed, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { area, line } from 'd3-shape';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { worldLandPath } from '@insights/plugins/world-land';
import { constrainGeoView, geoToScreen, geoWheelView, INITIAL_GEO_VIEW, panGeoBy, pinchGeo, revealGeoPoint, zoomGeoAt, type GeoPoint, type GeoViewport } from '../geo/geo-viewport';
import { useLabMotion } from '../../components/lab/motion';
import { gridFlowColor, gridNetworkConfig, networkRecords, type GridNode } from './grid-model';
import './grid-charts.css';

const format = (value: number | null, digits = 0) => value === null ? 'Unknown' : value.toLocaleString('en-US',{maximumFractionDigits:digits});

function LoadHistory({node}:{node:GridNode}) {
  const uid=useId().replaceAll(':',''),points=node.history;
  if(!points.length)return <p>No historical observations</p>;
  const start=points[0]?.timestamp??0,end=points.at(-1)?.timestamp??1;
  const values=points.flatMap(p=>p.value===null?[]:[p.value]),low=Math.min(0,...values),high=Math.max(1,...values);
  const x=(p:GridNode['history'][number])=>2+(p.timestamp-start)/Math.max(1,end-start)*196;
  const y=(v:number)=>3+(high-v)/(high-low)*39;
  const stroke=line<GridNode['history'][number]>().defined(p=>p.value!==null).x(x).y(p=>y(p.value!))(points);
  const fill=area<GridNode['history'][number]>().defined(p=>p.value!==null).x(x).y0(y(0)).y1(p=>y(p.value!))(points);
  return <><p>Load history · {new Date(start).toISOString().slice(11,16)}–{new Date(end).toISOString().slice(11,16)} UTC</p><svg className="grid-map-history" viewBox="0 0 200 45" preserveAspectRatio="none" role="img" aria-label={`${node.label} load history, positioned by exact observation time; missing samples leave gaps`}><defs><linearGradient id={`${uid}-history`} x2="0" y2="1"><stop stopColor="#27d7ea" stopOpacity=".15"/><stop offset="1" stopColor="#27d7ea" stopOpacity="0"/></linearGradient></defs>{fill&&<path d={fill} fill={`url(#${uid}-history)`}/>} {stroke&&<path d={stroke} fill="none" stroke="#27d7ea" strokeWidth="1.25" vectorEffect="non-scaling-stroke"/>}</svg></>;
}

/** Regional geography and all data layers share one projection and the existing bounded camera. */
export function GridNetworkMap({widget,result,embedded,onContextChange}:WidgetRendererProps) {
  const config=useMemo(()=>gridNetworkConfig.parse(widget.config??{}),[widget.config]);
  const data=useMemo(()=>result.records?networkRecords(result.records,config.maxNodes):{nodes:[],links:[],omitted:0},[result.records,config.maxNodes]);
  const box=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),camera=useRef<GeoViewport>(INITIAL_GEO_VIEW),frame=useRef<number|null>(null);
  const [view,setView]=useState(INITIAL_GEO_VIEW),[size,setSize]=useState({width:850,height:540}),[touch,setTouch]=useState(false),[selected,setSelected]=useState<string|null>(null),[pinned,setPinned]=useState(false);
  const revision=useRef(result), pointers=useRef(new Map<number,GeoPoint>()), moved=useRef(false), origin=useRef<GeoPoint|null>(null), candidate=useRef<string|null>(null);
  const uid=useId().replaceAll(':','');
  const {reduced}=useLabMotion();
  const inspectable=!embedded&&widget.options?.showTooltip!==false;
  const hoverDismiss=useTooltipDismiss({onDismiss:()=>setSelected(null),pinned,revision:result,enabled:inspectable});
  const bounds=useMemo(()=>{ const lons=data.nodes.map(n=>n.longitude),lats=data.nodes.map(n=>n.latitude); const west=(lons.length?Math.min(...lons):142)-1.1,east=(lons.length?Math.max(...lons):148)+1.1,south=(lats.length?Math.min(...lats):-38.5)-.65,north=(lats.length?Math.max(...lats):-34)+.65; return {west,east,south,north}; },[data.nodes]);
  const project=(longitude:number,latitude:number)=>({x:(longitude-bounds.west)/(bounds.east-bounds.west)*size.width,y:(bounds.north-latitude)/(bounds.north-bounds.south)*size.height});
  const positions=data.nodes.map(node=>({...node,...geoToScreen(project(node.longitude,node.latitude),view)}));
  const active=revision.current===result&&inspectable?data.nodes.find(node=>node.id===selected):undefined;
  useEffect(()=>{const element=box.current;if(!element)return;const measure=()=>{const w=element.clientWidth,h=element.clientHeight;if(w&&h)setSize(previous=>previous.width===w&&previous.height===h?previous:{width:w,height:h});};const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[]);
  useEffect(()=>{if(revision.current!==result){revision.current=result;setSelected(null);setPinned(false);}},[result]);
  useEffect(()=>{if(!inspectable){setSelected(null);setPinned(false);}},[inspectable]);
  const setCamera=(next:GeoViewport)=>{const constrained=constrainGeoView(next,size);if(constrained.x===camera.current.x&&constrained.y===camera.current.y&&constrained.k===camera.current.k)return false;camera.current=constrained;if(frame.current===null)frame.current=requestAnimationFrame(()=>{frame.current=null;setView(camera.current);});return true;};
  useEffect(()=>{camera.current=constrainGeoView(camera.current,size);setView(camera.current);},[size]);
  function point(clientX:number,clientY:number):GeoPoint {const matrix=svg.current?.getScreenCTM();if(matrix){const p=new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());return{x:p.x,y:p.y};}return{x:size.width/2,y:size.height/2};}
  useEffect(()=>{const element=svg.current;if(!element||embedded)return;const wheel=(event:WheelEvent)=>{const next=geoWheelView(camera.current,event,point(event.clientX,event.clientY),size);if(next){event.preventDefault();setCamera(next);}};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);},[size,embedded]);
  useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);},[]);
  const zoom=(factor:number)=>setCamera(zoomGeoAt(camera.current,factor,{x:size.width/2,y:size.height/2},size));
  const reset=()=>{pointers.current.clear();setCamera(INITIAL_GEO_VIEW);};
  function inspect(node:GridNode,pin=true){if(!inspectable)return;hoverDismiss.cancel();setSelected(node.id);setPinned(pin);if(pin)onContextChange?.({series:node.label,value:node.value,labels:{asset:node.id,status:node.status,latitude:String(node.latitude),longitude:String(node.longitude)}});}
  function dismiss(){hoverDismiss.cancel();setSelected(null);setPinned(false);restoreTooltipFocus(svg.current);}
  function choose(id:string){const node=data.nodes.find(n=>n.id===id);if(!node){hoverDismiss.cancel();setSelected(null);setPinned(false);return;}inspect(node);setCamera(revealGeoPoint(camera.current,project(node.longitude,node.latitude),size,40));}
  function down(event:ReactPointerEvent<SVGSVGElement>){if(embedded||event.button!==0||(event.pointerType==='touch'&&!touch))return;const p=point(event.clientX,event.clientY);pointers.current.set(event.pointerId,p);origin.current=p;moved.current=false;candidate.current=(event.target as Element).closest('[data-grid-node]')?.getAttribute('data-grid-node')??null;event.currentTarget.setPointerCapture(event.pointerId);}
  function move(event:ReactPointerEvent<SVGSVGElement>){const previous=pointers.current.get(event.pointerId);if(!previous)return;const next=point(event.clientX,event.clientY),before=[...pointers.current.values()];pointers.current.set(event.pointerId,next);if(origin.current&&Math.hypot(next.x-origin.current.x,next.y-origin.current.y)>4)moved.current=true;if(before.length===2){setCamera(pinchGeo(camera.current,before as [GeoPoint,GeoPoint],[...pointers.current.values()] as [GeoPoint,GeoPoint],size));}else setCamera(panGeoBy(camera.current,{x:next.x-previous.x,y:next.y-previous.y},size));}
  function end(event:ReactPointerEvent<SVGSVGElement>){const wasSingle=pointers.current.size===1;pointers.current.delete(event.pointerId);if(wasSingle&&!moved.current&&candidate.current&&event.type==='pointerup'){const node=data.nodes.find(n=>n.id===candidate.current);if(node)inspect(node);}candidate.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
  const longitudeTicks=Array.from({length:Math.ceil(bounds.east-bounds.west)},(_,i)=>Math.ceil(bounds.west)+i).filter(v=>v<bounds.east);
  const latitudeTicks=Array.from({length:Math.ceil(bounds.north-bounds.south)},(_,i)=>Math.ceil(bounds.south)+i).filter(v=>v<bounds.north);
  return <div className="grid-network" onPointerLeave={hoverDismiss.schedule} data-network-zoom={view.k} data-motion={reduced?'reduced':'auto'} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))hoverDismiss.schedule();}}>
    <div className="grid-network-canvas" ref={box}>
      <svg ref={svg} viewBox={`0 0 ${size.width} ${size.height}`} role="group" aria-label={widget.title} tabIndex={embedded?undefined:0} style={{touchAction:touch?'none':'pan-y'}} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={event=>pointers.current.delete(event.pointerId)} onClickCapture={event=>{if(moved.current){event.preventDefault();event.stopPropagation();moved.current=false;}}} onKeyDown={event=>{
        if(embedded||event.ctrlKey||event.metaKey||event.altKey)return;
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();return;}
        if(event.key==='+'||event.key==='='){if(zoom(1.5))event.preventDefault();}else if(event.key==='-'){if(zoom(1/1.5))event.preventDefault();}else if(event.key==='Home'){if(view.k!==1){event.preventDefault();reset();}}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){if(setCamera(panGeoBy(camera.current,{x:event.key==='ArrowLeft'?40:event.key==='ArrowRight'?-40:0,y:event.key==='ArrowUp'?40:event.key==='ArrowDown'?-40:0},size)))event.preventDefault();}
      }}>
        <defs><linearGradient id={`${uid}-land`} x2="1" y2="1"><stop stopColor="#132e37"/><stop offset="1" stopColor="#09252d"/></linearGradient><radialGradient id={`${uid}-water`}><stop stopColor="#0a2734"/><stop offset="1" stopColor="#041722"/></radialGradient><clipPath id={`${uid}-clip`}><rect width={size.width} height={size.height}/></clipPath></defs>
        <g clipPath={`url(#${uid}-clip)`}>
          <rect width={size.width} height={size.height} fill={`url(#${uid}-water)`}/>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g transform={`translate(${-((bounds.west+180)*2)*size.width/((bounds.east-bounds.west)*2)} ${-((90-bounds.north)*2)*size.height/((bounds.north-bounds.south)*2)}) scale(${size.width/((bounds.east-bounds.west)*2)} ${size.height/((bounds.north-bounds.south)*2)})`}><path d={worldLandPath} fill={`url(#${uid}-land)`} stroke="#2d5a67" strokeWidth="1" vectorEffect="non-scaling-stroke"/></g>
            {longitudeTicks.map(lon=><line key={`lon-${lon}`} x1={project(lon,0).x} x2={project(lon,0).x} y2={size.height} stroke="#28505b" strokeOpacity=".35" vectorEffect="non-scaling-stroke"/>)}
            {latitudeTicks.map(lat=><line key={`lat-${lat}`} y1={project(0,lat).y} y2={project(0,lat).y} x2={size.width} stroke="#28505b" strokeOpacity=".35" vectorEffect="non-scaling-stroke"/>)}
          </g>
          {config.showFlows&&data.links.map(link=>{const from=positions.find(n=>n.id===link.source)!,to=positions.find(n=>n.id===link.target)!,color=gridFlowColor(link.value,link.capacity);const mx=from.x+(to.x-from.x)*.55,my=from.y+(to.y-from.y)*.55,angle=Math.atan2(to.y-from.y,to.x-from.x)*180/Math.PI;return <g key={link.id} aria-label={`${from.label} to ${to.label}: ${format(link.value,2)} MW, capacity ${format(link.capacity)} MW`} role="img"><title>{from.label} → {to.label}: {format(link.value,2)} / {format(link.capacity)} MW</title><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={link.value/link.capacity>=.8?1.7:1.15}/><path d="M-4,-3L4,0L-4,3Z" fill={color} transform={`translate(${mx} ${my}) rotate(${angle})`}/></g>;})}
          {positions.map((node,index)=>{const chosen=node.id===active?.id,inView=node.x>=0&&node.x<=size.width&&node.y>=0&&node.y<=size.height;const color=node.value===null?'#8298a5':node.status==='Constrained'?'#ffc35a':'#27d7ea';const collision=positions.slice(0,index).some(other=>Math.hypot(other.x-node.x,other.y-node.y)<25);return <g key={node.id} data-grid-node={node.id} role={inspectable?'button':'img'} tabIndex={inspectable&&inView?0:undefined} aria-hidden={!inView||undefined} aria-label={`Inspect ${node.label}: ${format(node.value,2)} MW, ${node.status}`} aria-pressed={inspectable?chosen&&pinned:undefined} onClick={()=>inspect(node)} onFocus={()=>{if(!pinned)inspect(node,false);}} onPointerEnter={()=>{if(!pinned)inspect(node,false);}} onPointerLeave={hoverDismiss.schedule} onBlur={hoverDismiss.schedule} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();inspect(node);} }} className="grid-network-node"><circle cx={node.x} cy={node.y} r={14} fill="transparent"/><circle cx={node.x} cy={node.y} r={chosen?9:5.5} fill="#05212b" stroke={color} strokeWidth={chosen?2.3:1.2}/><circle cx={node.x} cy={node.y} r={chosen?4.5:3} fill={node.value===null?'#05212b':color}/>{config.showLabels&&(!collision||chosen)&&(size.width>550||chosen||index%3===0)&&<text x={node.x+11} y={node.y+(index%2?-8:17)} fill="#cce0e9" fontSize="11" paintOrder="stroke" stroke="#09222c" strokeWidth="3">{node.label}</text>}<title>{node.label} · {node.latitude}°, {node.longitude}° · {format(node.value,2)} MW</title></g>;})}
          {longitudeTicks.filter((_,i)=>i%2===0).map(lon=>{const p=geoToScreen(project(lon,bounds.south),view);return <text key={lon} x={p.x} y={size.height-10} textAnchor="middle" fontSize="10" fill="#7a9cae">{lon}°E</text>;})}
        </g>
      </svg>
      {!embedded&&<div className="grid-map-tools"><span>{Math.round(view.k*100)}%</span><button onClick={()=>zoom(1.5)} aria-label="Zoom in network map" disabled={view.k>=8}><Plus size={15}/></button><button onClick={()=>zoom(1/1.5)} aria-label="Zoom out network map" disabled={view.k<=1}><Minus size={15}/></button><button onClick={reset} aria-label="Reset network map" disabled={view.k===1}><RotateCcw size={14}/></button>{view.k>1&&<div className="grid-map-pan"><button aria-label="Pan network map north" disabled={view.y>=0} onClick={()=>setCamera(panGeoBy(camera.current,{x:0,y:48},size))}>↑</button><button aria-label="Pan network map west" disabled={view.x>=0} onClick={()=>setCamera(panGeoBy(camera.current,{x:48,y:0},size))}>←</button><button aria-label="Pan network map east" disabled={view.x<=size.width*(1-view.k)} onClick={()=>setCamera(panGeoBy(camera.current,{x:-48,y:0},size))}>→</button><button aria-label="Pan network map south" disabled={view.y<=size.height*(1-view.k)} onClick={()=>setCamera(panGeoBy(camera.current,{x:0,y:-48},size))}>↓</button></div>}</div>}
      {widget.options?.showLegend!==false&&<div className="grid-map-legend"><strong>Corridor load / capacity</strong><span><i style={{background:'#21d1e7'}}/>&lt;80% <i style={{background:'#ffc35a'}}/>80–99% <i style={{background:'#ff665c'}}/>≥100%</span><small>Arrows show reported direction</small></div>}
      {inspectable&&active&&<ChartTooltip pinned={pinned} onClose={dismiss} onLeave={hoverDismiss.schedule}><section className="grid-map-inspector" aria-label={`Substation details for ${active.label}`} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}}}><header><span><LocateFixed size={15}/>{active.label}</span><button aria-label="Close substation details" onClick={dismiss}><X size={14}/></button></header><dl><div><dt>Load</dt><dd>{format(active.value,2)} <small>MW</small></dd></div><div><dt>Voltage</dt><dd>{format(active.voltage)} <small>kV</small></dd></div><div><dt>Reserve</dt><dd>{format(active.reserve)} <small>MW</small></dd></div><div><dt>Status</dt><dd className={active.status==='Constrained'?'grid-amber':''}>{active.status}</dd></div></dl><LoadHistory node={active}/><footer><span>{active.latitude}°, {active.longitude}°</span><button onClick={()=>{hoverDismiss.cancel();setPinned(v=>!v);}}>{pinned?'Unpin':'Pin'}</button></footer></section></ChartTooltip>}
    </div>
    {!embedded&&<div className="grid-map-bottom"><label><span className="grid-sr">Inspect a substation</span><select aria-label="Inspect a substation" value={active?.id??''} onChange={event=>choose(event.target.value)}><option value="">Substations ({data.nodes.length})</option>{data.nodes.map(node=><option key={node.id} value={node.id}>{node.label} · {format(node.value,2)} MW</option>)}</select></label><span>Scroll to zoom · drag to pan</span><button aria-pressed={touch} onClick={()=>{setTouch(v=>!v);pointers.current.clear();}}>Touch {touch?'on':'off'}</button></div>}
    {!data.nodes.length&&<p className="grid-chart-empty">No valid network locations</p>}{data.omitted>0&&<p className="grid-chart-note">{data.omitted} invalid or bounded records omitted.</p>}
  </div>;
}
