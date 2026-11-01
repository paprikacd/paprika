import { useEffect, useState, type ReactNode } from 'react';
import { DomainInspector } from '../../components/lab/DomainInspector';
export function usePlotWidth(min=360){const [element,ref]=useState<HTMLDivElement|null>(null),[width,setWidth]=useState(720);useEffect(()=>{if(!element)return;const measure=()=>setWidth(Math.max(min,Math.round(element.clientWidth)));const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[min,element]);return{ref,width};}
export const num=(n:number|null,d=2)=>n===null?'Unknown':n.toLocaleString('en-US',{maximumFractionDigits:d});
export const utc=(n:number,full=false)=>new Date(n).toLocaleString('en-GB',{timeZone:'UTC',...(full?{day:'2-digit',month:'short'}:{}),hour:'2-digit',minute:'2-digit',hour12:false});
export const date=(n:number)=>new Date(n).toLocaleDateString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short'});
export function SpatialInspector({title,children,onClose,pinned=true}:{title:string;children:ReactNode;onClose:()=>void;pinned?:boolean}){return <DomainInspector title={title} pinned={pinned} onClose={onClose}>{children}</DomainInspector>;}
export function Legend({children}:{children:ReactNode}){return <div className="spatial-legend">{children}</div>;}
export function Dot({color,label}:{color:string;label:string}){return <span><i style={{background:color}}/>{label}</span>;}
