"use client"

import { useEffect, useId, useRef, useState } from "react"
import { z } from "zod"
import { formatMetric, EmptyState } from "../chart-renderers"
import type { RecordFrame } from "../schema"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import styles from "./records.module.css"

const key = z.string().min(1).max(128)
const configSchema = z.strictObject({
  x:key, y:z.array(key).min(1).max(8), group:key.optional(), rightAxis:z.array(key).max(8).optional(),
  annotations:z.array(z.strictObject({x:z.union([z.string().max(256),z.number().finite()]),label:z.string().min(1).max(100)})).max(20).optional(),
}).superRefine((value,context)=>{
  if (new Set(value.y).size !== value.y.length || value.rightAxis?.some(name=>!value.y.includes(name))) context.addIssue({code:"custom",message:"Choose unique value columns; right-axis columns must also be in y"})
})
type Config = z.infer<typeof configSchema>
type Datum = { x:number; value:number|null; row:RecordFrame["rows"][number] }
type PlotSeries = {name:string;key:string;right:boolean;unit:string;points:Datum[]}
const colors = ["#4e8a69","#5186b1","#ba7652","#9672b2","#aa8b45","#518f91","#b86a7c","#6d83ac"]

function plotData(frame:RecordFrame, config:Config) {
  const locate = (name:string) => {const index=frame.columns.findIndex(c=>c.key===name);if(index<0)throw new Error(`Missing chart column “${name}”.`);return index}
  const x=locate(config.x), group=config.group ? locate(config.group) : -1, category=frame.columns[x].type !== "number" && frame.columns[x].type !== "timestamp"
  const categories=[...new Set(frame.rows.flatMap(row=>row[x]===null?[]:[String(row[x])]))]
  const position=(value:string|number|boolean|null)=>value===null ? NaN : category ? categories.indexOf(String(value)) : frame.columns[x].type==="timestamp" ? Date.parse(String(value)) : Number(value)
  const groups=new Map<string,PlotSeries>()
  let omitted=0
  for(const name of config.y) {
    const y=locate(name)
    if(frame.columns[y].type!=="number")throw new Error(`Choose a numeric column for “${name}”.`)
    for(const row of frame.rows) {
      const at=position(row[x]);if(!Number.isFinite(at)){omitted++;continue}
      const groupName=group>=0?String(row[group]??"Unknown"):"", id=JSON.stringify([name,group>=0?row[group]:null])
      let series=groups.get(id)
      if(!series){series={name:[groupName,frame.columns[y].label??name].filter(Boolean).join(" · "),key:name,right:config.rightAxis?.includes(name)??false,unit:frame.columns[y].unit??"",points:[]};groups.set(id,series)}
      if(series.points.some(point=>point.x===at))throw new Error("Duplicate chart coordinates. Aggregate the source query or choose a grouping column.")
      series.points.push({x:at,value:typeof row[y]==="number"?row[y] as number:null,row})
    }
  }
  const series=[...groups.values()].map(entry=>({...entry,points:entry.points.toSorted((a,b)=>a.x-b.x)}))
  return {series,position,category,categories,omitted,xColumn:frame.columns[x]}
}

function RecordChart({widget,result,onContextChange,bar=false}:WidgetRendererProps & {bar?:boolean}) {
  const unique=useId()
  const plot=useRef<SVGSVGElement>(null)
  const [bounds,setBounds]=useState({width:600,height:280})
  const frame=result.records
  useEffect(()=>{
    const element=plot.current
    if(!element)return
    const measure=()=>{
      const {width,height}=element.getBoundingClientRect()
      if(width<=0||height<=0)return
      setBounds(previous=>Math.abs(previous.width-width)<.5&&Math.abs(previous.height-height)<.5?previous:{width,height})
    }
    measure()
    const observer=new ResizeObserver(measure)
    observer.observe(element)
    return ()=>observer.disconnect()
  },[frame])
  if(!frame?.rows.length)return <EmptyState/>
  const config=configSchema.parse(widget.config??{}), data=plotData(frame,config), series=data.series.slice(0,24)
  const all=series.flatMap(entry=>entry.points), xs=all.map(point=>point.x)
  if(!xs.length)return <EmptyState/>
  const positions=[...new Set(xs)].sort((a,b)=>a-b), minX=positions[0], maxX=positions.at(-1)!
  const spacing=positions.length>1?Math.min(...positions.slice(1).map((value,index)=>value-positions[index])):1
  const plotLeft=52,plotRight=Math.max(plotLeft+20,bounds.width-52),plotWidth=plotRight-plotLeft
  const plotTop=22,plotBottom=Math.max(plotTop+20,bounds.height-26),plotHeight=plotBottom-plotTop
  const yTicks=plotHeight<90?[0,.5,1]:[0,.25,.5,.75,1]
  // Each bar group has its own band, including the first and last category.
  // Padding the domain keeps complete bars inside the plot's clip rectangle.
  const padding=bar?spacing/2:0, domainMin=minX-padding, domainMax=maxX+padding
  const xScale=(x:number)=>domainMax===domainMin?(plotLeft+plotRight)/2:plotLeft+(x-domainMin)/(domainMax-domainMin)*plotWidth
  const barWidth=Math.min(28,plotWidth*spacing/(domainMax-domainMin||1)*.8/series.length)
  const extent=(right:boolean)=>{const values=series.filter(s=>s.right===right).flatMap(s=>s.points.flatMap(p=>p.value===null?[]:[p.value]));return {min:Math.min(0,...values),max:Math.max(1,...values)}}
  const left=extent(false),right=extent(true), scale=(value:number,isRight:boolean)=>{const range=isRight?right:left;return plotBottom-(value-range.min)/(range.max-range.min)*plotHeight}
  const xText=(x:number,exact=false)=>data.category?data.categories[Math.round(x)]??"":data.xColumn.type==="timestamp"?(exact?new Date(x).toISOString():maxX-minX<86_400_000?new Date(x).toISOString().slice(11,16):new Date(x).toISOString().slice(0,10)):exact?String(x):formatMetric(x,"",false,0)
  const ticks=(data.category?[minX,positions[Math.floor((positions.length-1)/2)],maxX]:[minX,minX+(maxX-minX)/2,maxX]).filter((x,i,list)=>list.indexOf(x)===i)
  const select=(entry:PlotSeries,point:Datum)=>onContextChange?.({series:entry.name,value:point.value,labels:Object.fromEntries(frame.columns.flatMap((column,i)=>point.row[i]===null?[]:[[column.key,String(point.row[i])]]))})
  return <div className={styles.wrapper}><svg ref={plot} className={styles.recordChart} viewBox={`0 0 ${bounds.width} ${bounds.height}`} role="group" aria-label={widget.title}>
    <defs><clipPath id={unique}><rect data-record-plot-height={plotHeight} x={plotLeft-2} y={plotTop-6} width={plotWidth+4} height={plotHeight+8}/></clipPath></defs>
    {yTicks.map(fraction=><g key={fraction}><line x1={plotLeft} x2={plotRight} y1={plotBottom-fraction*plotHeight} y2={plotBottom-fraction*plotHeight} stroke="var(--gamma-border)"/><text x={plotLeft-6} y={plotBottom+4-fraction*plotHeight} textAnchor="end">{formatMetric(left.min+fraction*(left.max-left.min),"",true,widget.options?.decimals)}</text>{series.some(s=>s.right)&&<text x={plotRight+6} y={plotBottom+4-fraction*plotHeight}>{formatMetric(right.min+fraction*(right.max-right.min),"",true,widget.options?.decimals)}</text>}</g>)}
    {ticks.map(x=><text key={x} x={xScale(x)} y={plotBottom+20} textAnchor="middle">{xText(x)}</text>)}
    <text x={plotLeft} y={12}>{series.filter(s=>!s.right).map(s=>s.unit).filter((unit,i,list)=>unit&&list.indexOf(unit)===i).join(" / ")}</text><text x={plotRight} y={12} textAnchor="end">{series.filter(s=>s.right).map(s=>s.unit).filter((unit,i,list)=>unit&&list.indexOf(unit)===i).join(" / ")}</text>
    <g clipPath={`url(#${unique})`}>{config.annotations?.map((annotation,i)=>{const at=data.position(annotation.x);return Number.isFinite(at)&&at>=minX&&at<=maxX?<g key={i}><title>{annotation.label}</title><line x1={xScale(at)} x2={xScale(at)} y1={plotTop-4} y2={plotBottom} stroke="var(--gamma-muted)" strokeDasharray="3 3"/><text x={xScale(at)+4} y={plotTop+10+i%3*12}>{annotation.label.slice(0,bounds.width<480?20:30)}</text></g>:null})}
    {series.map((entry,index)=>{
      let connected=false
      const path=entry.points.map(point=>{if(point.value===null){connected=false;return ""}const command=connected?"L":"M";connected=true;return `${command}${xScale(point.x)},${scale(point.value,entry.right)}`}).join(" ")
      const color=colors[index%colors.length], unit=entry.unit==="percent"?"%":entry.unit||widget.unit
      return <g key={index} aria-label={entry.name}>{!bar&&<path d={path} fill="none" stroke={color} strokeWidth={widget.options?.lineWidth??1.7}/>}{entry.points.slice(0,bar?100:1000).map((point,i)=>{
        if(point.value===null)return null
        const title=`${entry.name} · ${xText(point.x,true)} · ${formatMetric(point.value,unit,false,widget.options?.decimals)}`, selectPoint=()=>select(entry,point), zero=scale(0,entry.right),y=scale(point.value,entry.right)
        const props={onClick:selectPoint,onKeyDown:(event:React.KeyboardEvent<SVGElement>)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectPoint()}},role:onContextChange?"button" as const:"img" as const,tabIndex:onContextChange?0:undefined,"aria-label":title,fill:color}
        return bar?<rect key={i} {...props} x={xScale(point.x)+(index-series.length/2)*barWidth} y={Math.min(zero,y)} width={barWidth} height={Math.max(1,Math.abs(y-zero))}><title>{title}</title></rect>:<circle key={i} {...props} cx={xScale(point.x)} cy={y} r={entry.points.length<80?2.5:1.5}><title>{title}</title></circle>
      })}</g>
    })}</g>
  </svg>{widget.options?.showLegend!==false&&<div className={styles.legend}>{series.map((entry,index)=><span key={index}><i style={{background:colors[index%colors.length]}}/>{entry.name}{entry.right?" (right axis)":""}</span>)}</div>}
  {(frame.truncated||data.omitted>0||data.series.length>24||(bar&&series.some(s=>s.points.length>100)))&&<div className={styles.note}>{frame.truncated&&<span>Partial source response</span>}{data.omitted>0&&<span>{data.omitted} observations have no x coordinate</span>}{data.series.length>24&&<span>Showing first 24 of {data.series.length} series</span>}{bar&&series.some(s=>s.points.length>100)&&<span>Showing first 100 points per series</span>}</div>}</div>
}
export const RecordLine=(props:WidgetRendererProps)=><RecordChart {...props}/>
export const RecordBar=(props:WidgetRendererProps)=><RecordChart {...props} bar/>
export function registerRecordChartPlugins(){
  for(const entry of [{id:"records-line",label:"Record line chart",render:RecordLine},{id:"records-bar",label:"Record bar chart",render:RecordBar}])if(!getWidgetDefinition("plugin",entry.id))registerWidgetPlugin({...entry,dataKind:"records",description:"Plot exact application records and authored historical datasets",parseConfig:config=>configSchema.parse(config??{})})
}
