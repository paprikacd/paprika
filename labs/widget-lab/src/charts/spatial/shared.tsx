import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { DomainInspector } from '../../components/lab/DomainInspector';
export function usePlotWidth(min=360){const anchor=useRef<HTMLDivElement|null>(null),[element,setElement]=useState<HTMLDivElement|null>(null),[width,setWidth]=useState(720);const ref=useCallback((node:HTMLDivElement|null)=>{anchor.current=node;setElement(node);},[]);useEffect(()=>{if(!element)return;const measure=()=>setWidth(Math.max(min,Math.round(element.clientWidth)));const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[min,element]);return{ref,width,anchor};}
export const num=(n:number|null,d=2)=>n===null?'Unknown':n.toLocaleString('en-US',{maximumFractionDigits:d});
export const utc=(n:number,full=false)=>new Date(n).toLocaleString('en-GB',{timeZone:'UTC',...(full?{day:'2-digit',month:'short'}:{}),hour:'2-digit',minute:'2-digit',hour12:false});
export const date=(n:number)=>new Date(n).toLocaleDateString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short'});
export function SpatialInspector({title,children,onClose,pinned=true}:{title:string;children:ReactNode;onClose:()=>void;pinned?:boolean}){return <DomainInspector title={title} pinned={pinned} onClose={onClose}>{children}</DomainInspector>;}
export function Legend({children}:{children:ReactNode}){return <div className="spatial-legend">{children}</div>;}
export function Dot({color,label}:{color:string;label:string}){return <span><i style={{background:color}}/>{label}</span>;}
/** Gamma's 24-step density ramp as a left-to-right CSS gradient (legend keys). */
export const DENSITY_GRADIENT = `linear-gradient(90deg,${Array.from({length:24},(_,i)=>`var(--gamma-density-${i})`).join(',')})`;

/** Canvas fills cannot read var(), so the plot's Gamma tokens are resolved from its computed style. */
export function paintTokens(element:Element){
  const style=getComputedStyle(element),read=(name:string)=>style.getPropertyValue(name).trim();
  return{ramp:Array.from({length:24},(_,i)=>read(`--gamma-density-${i}`)),empty:read('--gamma-chart-empty'),hatch:read('--gamma-chart-hatch'),border:read('--gamma-border')};
}

/** The neutral hatch (45 degrees, 1.5px stripes on a 6px pitch, as PlotHatchDefs draws it) for canvas missing cells. */
export function hatchPattern(context:CanvasRenderingContext2D,empty:string,hatch:string){
  const tile=document.createElement('canvas');tile.width=6;tile.height=6;const paint=tile.getContext('2d');if(!paint)return null;
  paint.fillStyle=empty;paint.fillRect(0,0,6,6);paint.strokeStyle=hatch;paint.lineWidth=1.5;paint.beginPath();paint.moveTo(.75,0);paint.lineTo(.75,6);paint.stroke();
  const pattern=context.createPattern(tile,'repeat');if(pattern&&typeof DOMMatrix!=='undefined')pattern.setTransform(new DOMMatrix().rotate(45));return pattern;
}

/** A counter that changes when the enclosing Gamma scope switches theme, so canvas paints resolve the new tokens. */
export function useThemeRevision(anchor:RefObject<Element|null>){
  const[revision,setRevision]=useState(0);
  useEffect(()=>{const scope=anchor.current?.closest('[data-insights-theme]');if(!scope||typeof MutationObserver==='undefined')return;const observer=new MutationObserver(()=>setRevision(value=>value+1));observer.observe(scope,{attributes:true,attributeFilter:['data-insights-theme']});return()=>observer.disconnect();},[anchor]);
  return revision;
}
