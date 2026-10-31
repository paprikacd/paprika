import { useEffect, useState, type RefObject, type ReactNode } from 'react';
import { X } from 'lucide-react';

export const PALETTE={cyan:'#12c9df',violet:'#9c78f6',mint:'#19d5b0',amber:'#f7bd55',orange:'#ff7956',red:'#f36d79',muted:'#7094a6'};
export function usePlotWidth(ref:RefObject<HTMLElement|null>,fallback=640){const [width,setWidth]=useState(fallback);useEffect(()=>{const node=ref.current;if(!node)return;const update=()=>setWidth(Math.max(240,Math.round(node.getBoundingClientRect().width)));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[ref]);return width;}
export function Inspector({title,children,onClose,pinned=true}:{title:string;children:ReactNode;onClose:()=>void;pinned?:boolean}){return <section className="xp-inspector" aria-label={`${title} details`}><header><div><small>{pinned?'Selected evidence':'Inspecting'}</small><strong>{title}</strong></div><button onClick={onClose} aria-label={`Close ${title} details`}><X size={14}/></button></header>{children}</section>;}
export function DetailValues({items}:{items:[string,ReactNode][]}){return <dl className="xp-detail-values">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;}
export { useInspection } from '../shared/inspection';
export const utc=(timestamp:number)=>new Date(timestamp).toISOString().slice(11,19);
export function graphColor(type:string){return type==='Host'?PALETTE.cyan:type==='Account'?PALETTE.orange:type==='Process'?PALETTE.violet:type==='Domain'?PALETTE.amber:PALETTE.mint;}
export const linePath=(points:{x:number;y:number}[])=>points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
export function SvgEmpty({children='No observations in this result.'}:{children?:ReactNode}){return <div className="xp-empty">{children}</div>;}
export function localPoint(svg:SVGSVGElement,clientX:number,clientY:number){const matrix=svg.getScreenCTM();if(!matrix)return {x:0,y:0};return new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());}
