"use client"
import { useMemo, type CSSProperties } from "react"
import { EmptyState, ObservationDetails, formatMetric } from "../chart-renderers"
import { TooltipSubWidget } from "../tooltip-widgets"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import { worldLandPath } from "./world-land"
import { buildGeoHeatmap, geoHeatmapConfig } from "./geo-heatmap-data"
import styles from "./geo-heatmap.module.css"

const colors = ["#4ca582", "#76c7a6", "#91ded5", "#add9e6", "#c6c2ed", "#efd0e9", "#e992c1", "#ca4e92", "#a52663"]
export function GeoHeatmap({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = useMemo(() => geoHeatmapConfig.parse(widget.config ?? {}), [widget.config])
  const data = useMemo(() => result.records ? buildGeoHeatmap(result.records, config) : undefined, [result.records, config])
  if (!data || !data.cells.length) return <EmptyState />
  const unit = widget.unit || data.unit, decimals = widget.options?.decimals
  const formatted = (value: number | null) => value === null ? "No complete value" : formatMetric(value, unit, false, decimals)
  const radius = config.mode === "map" ? config.radius : 684 / config.gridColumns / Math.sqrt(3)
  const height = config.mode === "map" ? 360 : Math.max(45, 2 * radius + 10 + (Math.ceil(data.cells.length / config.gridColumns) - 1) * radius * 1.5)
  const label = config.aggregation === "count" ? "Record count" : config.aggregation === "sum" ? `Sum of ${config.value}` : `Mean of ${config.value}`
  return <div className={styles.wrapper} data-geo-heatmap={config.mode}>
    <div className={styles.scroll} role="region" aria-label={`${widget.title} heatmap`} tabIndex={embedded ? undefined : 0}>
      <div className={styles.plane} data-geo-plane={config.mode} style={{ "--plane-ratio": `720 / ${height}` } as CSSProperties}>
        {config.mode === "map" && <svg viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path d={worldLandPath} fillRule="evenodd" className={styles.land}/>
          {[-120,-60,0,60,120].map(lon => <line key={lon} x1={(lon+180)*2} x2={(lon+180)*2} y1="0" y2="360" className={styles.gridLine} />)}
          {[-60,-30,0,30,60].map(lat => <line key={lat} x1="0" x2="720" y1={(90-lat)*2} y2={(90-lat)*2} className={styles.gridLine} />)}
        </svg>}
        {data.cells.map(cell => {
          const fraction = cell.value === null || !Number.isFinite(data.min) ? 0 : data.max === data.min ? .5 : (cell.value-data.min)/(data.max-data.min)
          const color = colors[Math.max(0, Math.min(colors.length-1, Math.round(fraction*(colors.length-1))))]
          const title = `${cell.name} · ${label}: ${formatted(cell.value)} · ${cell.count} ${cell.count === 1 ? "record" : "records"}`
          return <div key={cell.key} className={styles.cellPosition} style={{ left: `${cell.x/720*100}%`, top: `${cell.y/height*100}%`, width: `${Math.sqrt(3)*radius/720*100}%`, height: `${radius*2/height*100}%` }}>
            <ObservationDetails className={styles.trigger} revision={result} enabled={!embedded && widget.options?.showTooltip !== false} avoidWidget label={title} selectOnFocus={false}
              onSelect={!embedded && onContextChange ? () => onContextChange({ labels: cell.labels, value: cell.value, series: cell.name }) : undefined}
              details={<><div className={styles.details}><strong>{cell.name}</strong><span>{label}: <b>{formatted(cell.value)}</b></span><span>Source records: <b>{cell.count}</b></span>{cell.missing > 0 && <span>{cell.missing} missing values{config.aggregation === "count" ? "" : "; aggregation unavailable"}</span>}{config.mode === "map" && <span>Nearby locations grouped in a projected hexagonal bin.</span>}{Object.entries(cell.labels).slice(0,8).map(([key, value]) => <span key={key}>{key}: {value}</span>)}</div>
                {widget.options?.tooltipView && <TooltipSubWidget view={widget.options.tooltipView} series={{ name: cell.name, labels: cell.labels, points: [] }} point={{ timestamp: NaN, value: cell.value }} unit={unit} color={widget.color} />}
              </>}>
              <span data-geo-cell="" data-missing={cell.value === null || undefined} className={styles.cell} style={{ "--hex-color": color } as CSSProperties}/>
            </ObservationDetails>
          </div>
        })}
      </div>
    </div>
    <div className={styles.footer}>
      {widget.options?.showLegend !== false && <div className={styles.legend} aria-label={`${label} color scale`}><span>{label}</span>{Number.isFinite(data.min) && <><span>{formatted(data.min)}</span><span className={styles.ramp}>{colors.map(color => <i key={color} style={{background:color}} />)}</span><span>{formatted(data.max)}</span></>}<span className={styles.unknown}>Missing</span></div>}
      <span>{config.mode === "map" ? "Hex bins group nearby recorded locations; empty areas are unobserved." : "Each hexagon represents one record."}</span><span className={styles.scrollHint}>Scroll horizontally to explore</span>
      {data.invalid > 0 && <span>{data.invalid} invalid coordinates omitted</span>}{data.omitted > 0 && <span>{data.omitted} records omitted by the display limit</span>}{data.frame.truncated && <span>Partial source response</span>}
    </div>
  </div>
}

export function registerGeoHeatmapPlugin() {
  if (!getWidgetDefinition("plugin", "geo-heatmap")) registerWidgetPlugin({
    id: "geo-heatmap", label: "Hex heatmap", description: "Inspect values as geographic bins or a honeycomb of records", dataKind: "records", render: GeoHeatmap,
    parseConfig: config => geoHeatmapConfig.parse(config ?? {}), defaultConfig: { mode: "map", latitude: "latitude", longitude: "longitude", label: "label", aggregation: "count" },
    styleControls: ["unit", "decimals", "legend", "tooltips"],
    configFields: [
      { key: "mode", label: "Layout", kind: "select", options: [{ value: "map", label: "Geographic hex bins" }, { value: "grid", label: "Record honeycomb" }] },
      { key: "latitude", label: "Latitude field", kind: "text" }, { key: "longitude", label: "Longitude field", kind: "text" },
      { key: "label", label: "Label field", kind: "text" }, { key: "value", label: "Value field", kind: "text", help: "Numeric field used by sum or mean; missing values make the bin unknown." },
      { key: "aggregation", label: "Bin value", kind: "select", options: [{ value: "count", label: "Count records" }, { value: "sum", label: "Sum values" }, { value: "mean", label: "Mean value" }] },
      { key: "radius", label: "Map bin size", kind: "number", min: 8, max: 36, help: "Hex radius in projected map pixels." }, { key: "gridColumns", label: "Honeycomb columns", kind: "number", min: 8, max: 48 }, { key: "maxRecords", label: "Maximum records", kind: "number", min: 1, max: 500 },
    ],
  })
}
