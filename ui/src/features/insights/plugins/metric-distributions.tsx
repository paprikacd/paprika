"use client"

import { arc, pie } from "d3-shape"
import { z } from "zod"
import { EmptyState, formatMetric, seriesName, thresholdForValue } from "../chart-renderers"
import { downsamplePoints } from "../chart-data"
import { validTimestamp } from "../widget-context"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import styles from "./records.module.css"

const pieConfig = z.strictObject({ donut: z.boolean().optional() })
const historyConfig = z.strictObject({ maxSeries: z.number().int().min(1).max(24).optional(), maxPoints: z.number().int().min(8).max(120).optional() })

export function MetricPie({ widget, result, onContextChange }: WidgetRendererProps) {
  const config = pieConfig.parse(widget.config ?? {})
  const samples = (result.series ?? []).map((series, index) => {
    const latest = series.points.filter(point => validTimestamp(point.timestamp)).reduce<(typeof series.points)[number] | undefined>((last, point) => !last || point.timestamp >= last.timestamp ? point : last, undefined)
    return { series, name: seriesName(series,index), latest }
  })
  const positive = samples.filter(sample => typeof sample.latest?.value === "number" && Number.isFinite(sample.latest.value) && sample.latest.value > 0)
  if (!positive.length) return <EmptyState />
  const slices = pie<(typeof positive)[number]>().value(sample => sample.latest!.value!).sort(null)(positive)
  const path = arc<(typeof slices)[number]>().innerRadius(config.donut === false ? 0 : 58).outerRadius(92).padAngle(.02).cornerRadius(2)
  return <div className={styles.wrapper}>
    <svg className={styles.treemap} viewBox="0 0 360 210" role="group" aria-label={widget.title}>{slices.map((slice,index) => {
      const sample = slice.data, formatted = formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)
      const select = () => onContextChange?.({ labels:sample.series.labels, value:sample.latest!.value!, series:sample.name })
      return <g key={index} role={onContextChange ? "button" : "img"} tabIndex={onContextChange ? 0 : undefined} aria-label={`${sample.name}: ${formatted}`} onClick={select} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") {event.preventDefault();select()} }}><title>{sample.name}: {formatted}</title><path transform="translate(180 105)" d={path(slice) ?? ""} fill={`var(--record-color-${index%6})`} stroke="var(--gamma-border)" strokeWidth={.5}/></g>
    })}</svg>
    {widget.options?.showLegend !== false && <div className={styles.legend}>{positive.map((sample,index) => <span key={index}><i style={{background:`var(--record-color-${index%6})`}} />{sample.name} <b>{formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)}</b></span>)}</div>}
    {positive.length < samples.length && <p className={styles.note}>{samples.length-positive.length} zero, missing or negative latest values have no slice area</p>}
    {result.truncated && <p className={styles.note}>Partial source response</p>}
  </div>
}

export function StatusHistory({ widget,result,onContextChange }: WidgetRendererProps) {
  const config = historyConfig.parse(widget.config ?? {}), maxSeries = config.maxSeries ?? 12, maxPoints = config.maxPoints ?? 60
  const series = result.series ?? []
  if (!series.length) return <EmptyState />
  let sampled = false
  return <div className={styles.wrapper}><div className={styles.scroll} tabIndex={0} role="region" aria-label={`${widget.title} history`}><div className={styles.history}>{series.slice(0,maxSeries).map((entry,index) => {
    const name = seriesName(entry,index), ordered = entry.points.filter(point => validTimestamp(point.timestamp)).toSorted((a,b)=>a.timestamp-b.timestamp)
    const points = downsamplePoints(ordered,maxPoints)
    sampled ||= points.length < ordered.length
    return <div key={index} className={styles.historyRow}><strong>{name}</strong><div className={styles.historyCells}>{points.map((point,i) => {
      const finite = typeof point.value === "number" && Number.isFinite(point.value), threshold = finite ? thresholdForValue(point.value!,widget.options?.thresholds) : undefined
      const title = `${name} · ${new Date(point.timestamp).toLocaleString()} · ${finite ? formatMetric(point.value!,widget.unit,false,widget.options?.decimals) : "No data"}${threshold?.label ? ` · ${threshold.label}` : ""}`
      return <button key={i} type="button" aria-label={title} title={title} style={{background:finite ? threshold?.color ?? widget.color ?? "var(--gamma-accent, #53876a)" : "var(--gamma-border)"}} onClick={()=>onContextChange?.({labels:entry.labels,value:finite ? point.value : null,series:name})} />
    })}</div></div>
  })}</div></div><div className={styles.note}><span>Earlier → latest · gaps are unknown</span>{(sampled || series.length > maxSeries) && <span>Sampled view · {Math.min(maxSeries,series.length)} of {series.length} series</span>}{result.truncated && <span>Partial source response</span>}</div></div>
}

export function registerMetricDistributionPlugins() {
  if (!getWidgetDefinition("plugin","pie")) registerWidgetPlugin({id:"pie",label:"Pie / donut",description:"Compare positive shares at the latest observation",dataKind:"metrics",render:MetricPie,parseConfig:config=>pieConfig.parse(config ?? {})})
  if (!getWidgetDefinition("plugin","status-history")) registerWidgetPlugin({id:"status-history",label:"Status history",description:"See recorded states over time, including unknown samples",dataKind:"metrics",render:StatusHistory,parseConfig:config=>historyConfig.parse(config ?? {})})
}
