import { useEffect, useState, type RefObject, type ReactNode } from 'react';
import { DomainInspector } from '../../components/lab/DomainInspector';

/** Series and status roles as Gamma token references (lenses import this map). */
export const PALETTE={cyan:'var(--gamma-chart-1)',violet:'var(--gamma-chart-2)',mint:'var(--gamma-chart-5)',amber:'var(--gamma-chart-3)',orange:'var(--gamma-accent)',red:'var(--gamma-danger)',muted:'var(--gamma-muted)'};
export function usePlotWidth(ref:RefObject<HTMLElement|null>,fallback=640){const [width,setWidth]=useState(fallback);useEffect(()=>{const node=ref.current;if(!node)return;const update=()=>setWidth(Math.max(240,Math.round(node.getBoundingClientRect().width)));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[ref]);return width;}
export function Inspector({title,children,onClose,pinned=true}:{title:string;children:ReactNode;onClose:()=>void;pinned?:boolean}){return <DomainInspector title={title} pinned={pinned} onClose={onClose}>{children}</DomainInspector>;}
export function DetailValues({items}:{items:[string,ReactNode][]}){return <dl className="xp-detail-values">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;}
export { useInspection } from '../shared/inspection';
export const utc=(timestamp:number)=>new Date(timestamp).toISOString().slice(11,19);
export function graphColor(type:string){return type==='Host'?'var(--gamma-chart-1)':type==='Account'?'var(--gamma-accent)':type==='Process'?'var(--gamma-chart-2)':type==='Domain'?'var(--gamma-chart-3)':'var(--gamma-chart-5)';}
export const linePath=(points:{x:number;y:number}[])=>points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
export function SvgEmpty({children='No observations in this result.'}:{children?:ReactNode}){return <div className="xp-empty">{children}</div>;}
export function localPoint(svg:SVGSVGElement,clientX:number,clientY:number){const matrix=svg.getScreenCTM();if(!matrix)return {x:0,y:0};return new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse());}
