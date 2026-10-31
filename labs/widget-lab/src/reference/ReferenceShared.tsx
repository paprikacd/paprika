import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, Info as InfoIcon } from 'lucide-react';
import { area, line } from 'd3-shape';

export function PaprikaMark() {
  return <svg viewBox="0 0 34 48" fill="none" aria-hidden="true"><path d="M24 1c-4 5-2 8-1 11l4-3c-1 5 5 10 4 16-1 8-11 13-17 22 0-9-12-14-11-23 0-7 5-11 10-14-1 6 4 8 6 11 4 5 1 10-2 13 7-5 8-12 2-18-4-4-4-9 5-15Z" fill="currentColor"/></svg>;
}
export function NetworkMark({size=26}: {size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M11 7 6.3 17M15 7l4.7 10M9 20h8"/><circle cx="13" cy="5" r="3"/><circle cx="5" cy="20" r="3"/><circle cx="21" cy="20" r="3"/></svg>;
}
export function Dot({ color }: { color: string }) { return <i className="ref-dot" style={{ background: color }} aria-hidden="true"/>; }
export function Info({ text = 'Authored synthetic reference fixture. This view reconstructs the supplied concept image; it is not connected to live telemetry.' }: { text?: string }) {
  return <details className="ref-info" onKeyDown={e => { if(e.key === 'Escape'){ e.currentTarget.open=false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="About this panel"><InfoIcon size={15}/></summary><div>{text}</div></details>;
}
export function RefPanel({ title, info, action, className = '', children, style, scrollLabel }: { title: ReactNode; info?: string; action?: ReactNode; className?: string; children: ReactNode; style?: CSSProperties; scrollLabel?: string }) {
  return <section className={`ref-panel ${className}`} style={style}><header className="ref-panel-header"><h2>{title}<Info text={info}/></h2>{action}</header><div className="ref-panel-body" tabIndex={scrollLabel?0:undefined} role={scrollLabel?'region':undefined} aria-label={scrollLabel}>{children}</div></section>;
}
export function RefSelect({ value, options, onChange, label, className = '', style }: { value: string; options: string[]; onChange?: (value:string)=>void; label?: string; className?: string; style?: CSSProperties }) {
  const [local,setLocal] = useState(value);
  return <label className={`ref-select-field ${className}`} style={style}>{label && <span className="ref-sr-only">{label}</span>}<span className="ref-select"><select aria-label={label ?? options[0]} value={onChange ? value : local} onChange={e=>{setLocal(e.target.value); onChange?.(e.target.value);}}>{options.map(option=><option key={option} value={option}>{option}</option>)}</select><ChevronDown size={14}/></span></label>;
}
export function MiniTrace({ values, color, height=32, width=180, fill=true, min, max }: { values: Array<number|null>; color: string; height?: number; width?: number; fill?: boolean; min?: number; max?: number }) {
  const id=useId().replace(/:/g,'');
  const finite=values.filter((value):value is number=>value!==null&&Number.isFinite(value));
  const lo=min ?? Math.min(...finite), hi=max ?? Math.max(...finite), span=Math.max(.000001,hi-lo);
  const point=(v:number,i:number):[number,number]=>[i*width/Math.max(1,values.length-1),3+(1-(v-lo)/span)*(height-7)];
  const points=values.map((value,i)=>value===null?[i*width/Math.max(1,values.length-1),NaN] as [number,number]:point(value,i)), path=line<[number,number]>().defined(d=>Number.isFinite(d[1]))(points)??'', shade=area<[number,number]>().defined(d=>Number.isFinite(d[1])).x(d=>d[0]).y0(height).y1(d=>d[1])(points)??'';
  return <svg className="ref-mini-trace" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={`mini-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".35"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs>{fill&&<path d={shade} fill={`url(#mini-${id})`}/>}<path d={path} fill="none" stroke={color} strokeWidth="1.15" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/></svg>;
}
