"use client"
import { useMemo, type CSSProperties } from "react"
import { EmptyState, ObservationDetails, formatMetric } from "../chart-renderers"
import { TooltipSubWidget } from "../tooltip-widgets"
import { TooltipDetail, TooltipFact } from "../tooltip-content"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import { GeographicPlot } from "../geographic-plot"
import { densityPalette as colors } from "../density-palette"
import { usePlotSize } from "../chart-renderer-shared"
import hatchStyles from "../plot-hatch.module.css"
import { buildGeoHeatmap, geoHeatmapConfig } from "./geo-heatmap-data"
import styles from "./geo-heatmap.module.css"

// The fill and interaction contour must use the same six vertices. A CSS
// outline follows the button's rectangular hit area instead of this shape.
const hexVertices = [[50, 2], [96, 26], [96, 74], [50, 98], [4, 74], [4, 26]]
const hexPoints = hexVertices.map(point => point.join(",")).join(" ")
const hexClip = `polygon(${hexVertices.map(([x, y]) => `${x}% ${y}%`).join(",")})`

export function GeoHeatmap({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = useMemo(() => geoHeatmapConfig.parse(widget.config ?? {}), [widget.config])
  const data = useMemo(() => result.records ? buildGeoHeatmap(result.records, config) : undefined, [result.records, config])
  if (!data || !data.cells.length) return <EmptyState />
  return <GeoHeatmapContent widget={widget} result={result} embedded={embedded} onContextChange={onContextChange} config={config} data={data} />
}

function GeoHeatmapContent({ widget, result, embedded, onContextChange, config, data }: WidgetRendererProps & {
  config: ReturnType<typeof geoHeatmapConfig.parse>;
  data: ReturnType<typeof buildGeoHeatmap>;
}) {
  const { ref, width, height: availableHeight } = usePlotSize()
  // Unspecified columns adapt to the panel. Explicit columns remain authored.
  const columns = config.gridColumns ?? Math.min(48, Math.max(8, Math.ceil(Math.sqrt(data.cells.length * Math.sqrt(3) / 2 * width / Math.max(48, availableHeight)))))
  const unit = widget.unit || data.unit, decimals = widget.options?.decimals
  const formatted = (value: number | null) => value === null ? "No complete value" : formatMetric(value, unit, false, decimals)
  const radius = config.mode === "map" ? config.radius : 684 / columns / Math.sqrt(3)
  const height = config.mode === "map" ? 360 : Math.max(45, 2 * radius + 10 + (Math.ceil(data.cells.length / columns) - 1) * radius * 1.5)
  const label = config.aggregation === "count" ? "Record count" : config.aggregation === "sum" ? `Sum of ${config.value}` : `Mean of ${config.value}`
  const planeWidth = config.mode === "map" ? 720 : 684 + 684 / columns / 2 + 10
  const cells = data.cells.map((cell, index) => {
          const fraction = cell.value === null || !Number.isFinite(data.min) ? 0 : data.max === data.min ? .5 : (cell.value-data.min)/(data.max-data.min)
          const color = colors[Math.max(0, Math.min(colors.length-1, Math.round(fraction*(colors.length-1))))]
          const title = `${cell.name} · ${label}: ${formatted(cell.value)} · ${cell.count} ${cell.count === 1 ? "record" : "records"}`
          const row = Math.floor(index / columns), step = 684 / columns
          const x = config.mode === "map" ? cell.x : step / 2 + 5 + index % columns * step + row % 2 * step / 2
          const y = config.mode === "map" ? cell.y : radius + 5 + row * radius * 1.5
          return <div key={cell.key} className={styles.cellPosition} style={{ left: `${x/planeWidth*100}%`, top: `${y/height*100}%`, width: `${Math.sqrt(3)*radius/planeWidth*100}%`, height: `${radius*2/height*100}%` }}>
            <ObservationDetails mark className={styles.trigger} revision={result} enabled={!embedded && widget.options?.showTooltip !== false} avoidWidget label={title} selectOnFocus={false}
              onSelect={!embedded && onContextChange ? () => onContextChange({ labels: cell.labels, value: cell.value, series: cell.name }) : undefined}
              details={<><TooltipDetail title={cell.name}>
                <TooltipFact label={label}>{formatted(cell.value)}</TooltipFact>
                <TooltipFact label="Source records">{cell.count}</TooltipFact>
                {cell.missing > 0 && <span>{cell.missing} missing values{config.aggregation === "count" ? "" : "; aggregation unavailable"}</span>}
                {config.mode === "map" && <span>Nearby locations grouped in a projected hexagonal bin.</span>}
                {Object.entries(cell.labels).slice(0,8).map(([key, value]) => <TooltipFact key={key} label={key}>{value}</TooltipFact>)}
              </TooltipDetail>
                {widget.options?.tooltipView && <TooltipSubWidget view={widget.options.tooltipView} series={{ name: cell.name, labels: cell.labels, points: [] }} point={{ timestamp: NaN, value: cell.value }} unit={unit} color={widget.color} />}
              </>}>
              <span data-geo-cell="" data-missing={cell.value === null || undefined} className={`${styles.cell} ${cell.value === null ? hatchStyles.hatch : ""}`} style={{ "--hex-color": color } as CSSProperties}/>
              <svg data-geo-outline="" className={styles.contour} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                <polygon className={styles.contourHalo} points={hexPoints} />
                <polygon className={styles.contourEdge} points={hexPoints} />
              </svg>
            </ObservationDetails>
          </div>
        })
  return <div className={styles.wrapper} data-geo-heatmap={config.mode} style={{ "--hex-clip": hexClip } as CSSProperties}>
    <div ref={ref} className={styles.viewport} data-layout={config.mode}>
      {config.mode === "map" ? <GeographicPlot showGrid={widget.options?.showGrid !== false}>{cells}</GeographicPlot> :
        <div className={styles.scroll} role="region" aria-label={`${widget.title} heatmap`} tabIndex={embedded ? undefined : 0}>
          <div className={styles.plane} data-geo-plane="grid" style={{ "--plane-aspect": planeWidth / height, "--grid-columns": columns } as CSSProperties}>{cells}</div>
        </div>}
    </div>
    <div className={styles.footer}>
      {widget.options?.showLegend !== false && <div className={styles.legend} aria-label={`${label} color scale`}><span>{label}</span>{Number.isFinite(data.min) && <><span>{formatted(data.min)}</span><span className={styles.ramp}>{colors.map(color => <i key={color} style={{background:color}} />)}</span><span>{formatted(data.max)}</span></>}<span className={styles.unknown}><i className={hatchStyles.hatch}/>Missing</span></div>}
      <span>{config.mode === "map" ? "Hex bins group recorded locations · empty areas are unobserved" : `${data.cells.length} records · one per hexagon`}</span>{config.mode === "grid" && <span className={styles.scrollHint}>Scroll to explore all records</span>}
      {data.invalid > 0 && <span>{data.invalid} invalid coordinates omitted</span>}{data.omitted > 0 && <span>{data.omitted} records omitted by the display limit</span>}{data.frame.truncated && <span>Partial source response</span>}
    </div>
  </div>
}

export function registerGeoHeatmapPlugin() {
  if (!getWidgetDefinition("plugin", "geo-heatmap")) registerWidgetPlugin({
    id: "geo-heatmap", label: "Hex heatmap", description: "Inspect values as geographic bins or a honeycomb of records", dataKind: "records", render: GeoHeatmap,
    sizing: { mode: "fill", minHeight: 320 },
    parseConfig: config => geoHeatmapConfig.parse(config ?? {}), defaultConfig: { mode: "map", latitude: "latitude", longitude: "longitude", label: "label", aggregation: "count" },
    styleControls: ["unit", "decimals", "legend", "grid", "tooltips"],
    configFields: [
      { key: "mode", label: "Layout", kind: "select", options: [{ value: "map", label: "Geographic hex bins" }, { value: "grid", label: "Record honeycomb" }] },
      { key: "latitude", label: "Latitude field", kind: "text" }, { key: "longitude", label: "Longitude field", kind: "text" },
      { key: "label", label: "Label field", kind: "text" }, { key: "value", label: "Value field", kind: "text", help: "Numeric field used by sum or mean; missing values make the bin unknown." },
      { key: "aggregation", label: "Bin value", kind: "select", options: [{ value: "count", label: "Count records" }, { value: "sum", label: "Sum values" }, { value: "mean", label: "Mean value" }] },
      { key: "radius", label: "Map bin size", kind: "number", min: 8, max: 36, help: "Hex radius in projected map pixels." }, { key: "gridColumns", label: "Honeycomb columns", kind: "number", min: 8, max: 48, help: "Leave unset to fit all records to the panel; explicit columns preserve your layout." }, { key: "maxRecords", label: "Maximum records", kind: "number", min: 1, max: 500 },
    ],
  })
}
