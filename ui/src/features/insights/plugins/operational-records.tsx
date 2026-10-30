"use client"

import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { EmptyState, ObservationDetails, formatMetric, thresholdForValue } from "../chart-renderers"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps, type WidgetPlugin } from "../widget-registry"
import type { DrilldownContext } from "../drilldown"
import type { QueryResult } from "../schema"
import {
  buildConnectionMap, buildIncidentCalendar, buildPipelineTopology,
  connectionMapConfig, incidentCalendarConfig, pipelineTopologyConfig, statusTone,
} from "./operational-records-data"
import styles from "./operational-records.module.css"
import { worldLandPath } from "./world-land"

const metric = (value: number | null, unit: string, decimals?: number) => value === null ? "No observed value" : formatMetric(value, unit === "percent" ? "%" : unit, false, decimals)
// Compact spoken labels avoid floating-point artifacts; the selected context
// continues to carry the original unrounded source coordinate.
const coordinate = (value: number) => String(Number(value.toFixed(4)))

function Inspect({label, context, details, children, className, props, selectOnFocus, avoidWidget, tabIndex}: {
  label: string; context: DrilldownContext; details: ReactNode; children: ReactNode; className?: string; props: WidgetRendererProps; selectOnFocus?: boolean; avoidWidget?: boolean; tabIndex?: number
}) {
  return <ObservationDetails label={label} className={className} details={details} revision={props.result}
    selectOnFocus={selectOnFocus} avoidWidget={avoidWidget} tabIndex={tabIndex}
    enabled={!props.embedded && props.widget.options?.showTooltip !== false}
    onSelect={!props.embedded && props.onContextChange ? () => props.onContextChange!(context) : undefined}>{children}</ObservationDetails>
}

function Detail({title, children}: {title: string; children: ReactNode}) {
  return <div className={styles.details}><strong>{title}</strong>{children}</div>
}
function Fact({label, children}: {label: string; children: ReactNode}) {
  return <div className={styles.fact}><span>{label}</span><b>{children}</b></div>
}
function Status({value}: {value: string}) {
  return value ? <span className={styles.status} data-tone={statusTone(value)}><i aria-hidden="true"/>{value}</span> : <span className={styles.muted}>Status not supplied</span>
}
function Notes({children, truncated}: {children: ReactNode; truncated?: boolean}) {
  return <div className={styles.notes} role="status">{children}{truncated && <span>Partial result · source limit reached</span>}</div>
}

function PipelineViewport({children, width, height, embedded}: {children: ReactNode; width: number; height: number; embedded?: boolean}) {
  const id = useId()
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({left: 0, maximum: 0, verticalMaximum: 0})
  useLayoutEffect(() => {
    if (!viewport) return
    const measure = () => {
      const left = viewport.scrollLeft, maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      const verticalMaximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      setPosition(previous => previous.left === left && previous.maximum === maximum && previous.verticalMaximum === verticalMaximum ? previous : {left, maximum, verticalMaximum})
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(viewport)
    viewport.addEventListener("scroll", measure, {passive: true})
    return () => { observer?.disconnect(); viewport.removeEventListener("scroll", measure) }
  }, [viewport, width, height])
  const move = (direction: number) => viewport?.scrollBy({left: direction * Math.max(120, viewport.clientWidth * .8)})
  return <>
    {(position.maximum > 1 || position.verticalMaximum > 1) && !embedded && <div className={styles.diagramNavigation}>
      <span id={`${id}-guidance`}>Scroll to explore all stages{position.verticalMaximum > 1 ? " vertically" : ""}</span>
      {position.maximum > 1 && <><GammaButton size="sm" iconOnly variant="quiet" aria-label="Previous pipeline stages" aria-controls={id} disabled={position.left <= 1} onClick={() => move(-1)}><ChevronLeft size={15}/></GammaButton>
      <GammaButton size="sm" iconOnly variant="quiet" aria-label="Next pipeline stages" aria-controls={id} disabled={position.left >= position.maximum - 1} onClick={() => move(1)}><ChevronRight size={15}/></GammaButton></>}
    </div>}
    <div ref={setViewport} id={id} className={styles.topologyScroll} style={{minHeight: `min(${height + 2}px, 65%)`}} role="region" aria-label="Pipeline diagram" aria-describedby={!embedded && (position.maximum > 1 || position.verticalMaximum > 1) ? `${id}-guidance` : undefined} tabIndex={embedded ? undefined : 0}>{children}</div>
  </>
}

export function ConnectionMap(props: WidgetRendererProps) {
  const {widget, result} = props
  const config = useMemo(() => connectionMapConfig.parse(widget.config ?? {}), [widget.config])
  const data = useMemo(() => result.records ? buildConnectionMap(result.records, config) : undefined, [result.records, config])
  const [locationSearch, setLocationSearch] = useState("")
  const [locationPage, setLocationPage] = useState(0)
  const [overlap, setOverlap] = useState<{records: QueryResult["records"]; keys: string[]}>()
  const overlapPicker = useRef<HTMLElement>(null), overlapOpener = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    const picker = overlapPicker.current
    if (!picker || !overlap || overlap.records !== result.records) return
    picker.scrollIntoView?.({block:"nearest"})
    picker.focus({preventScroll:true})
  }, [overlap, result.records])
  if (!data) return <EmptyState/>
  const unit = widget.unit || data.valueUnit, decimals = widget.options?.decimals
  const maximum = Math.max(1, ...data.locations.flatMap(location => location.value === null ? [] : [Math.abs(location.value)]))
  const density = config.display === "density", showGrid = config.showGrid ?? !density, showCoordinates = config.showCoordinates ?? !density
  const thresholds = widget.options?.thresholds ?? []
  const largeMap = data.locations.length > 20
  const matchingLocations = data.locations.filter(location => `${location.label} ${location.status}`.toLocaleLowerCase().includes(locationSearch.trim().toLocaleLowerCase()))
  const pages = Math.max(1, Math.ceil(matchingLocations.length / 20)), currentPage = Math.min(locationPage, pages - 1)
  const displayedLocations = matchingLocations.slice(currentPage * 20, (currentPage + 1) * 20)
  const overlapKeys = new Set(overlap && overlap.records === result.records ? overlap.keys : [])
  const overlaps = data.locations.filter(location => overlapKeys.has(location.key))
  const chooseOverlaps = (event: MouseEvent<HTMLDivElement>) => {
    // Keyboard activation targets a specific focused button; only pointer
    // activation needs a choice between hitboxes under the same screen point.
    if (props.embedded || event.detail === 0 || !(event.target instanceof Element) || !event.target.closest("[data-map-location-key]") || typeof document.elementsFromPoint !== "function") return
    const plane = event.currentTarget
    const keys = [...new Set(document.elementsFromPoint(event.clientX, event.clientY).flatMap(element => {
      const marker = element.closest<HTMLElement>("[data-map-location-key]")
      return marker && plane.contains(marker) && marker.dataset.mapLocationKey !== undefined ? [marker.dataset.mapLocationKey] : []
    }))]
    if (keys.length < 2) return
    event.preventDefault(); event.stopPropagation()
    overlapOpener.current = event.target.closest<HTMLButtonElement>("button")
    setOverlap({records: result.records, keys})
  }
  const closeOverlaps = () => {
    setOverlap(undefined)
    if (overlapOpener.current?.isConnected) overlapOpener.current.focus({preventScroll:true})
  }
  const details = (location: typeof data.locations[number]) => <Detail title={location.label}>
    {config.value && <Fact label="Observed value">{metric(location.value, unit, decimals)}</Fact>}
    <Fact label="Latitude">{location.latitude.toFixed(4)}°</Fact><Fact label="Longitude">{location.longitude.toFixed(4)}°</Fact>
    {location.status && <Status value={location.status}/>}
    <dl className={styles.labels}>{Object.entries(location.context.labels ?? {}).filter(([key]) => ![config.latitude, config.longitude, config.label, config.value, config.status].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
  </Detail>
  return <div className={styles.wrapper} data-operational-chart="connection-map" data-choosing-locations={overlaps.length > 1 || undefined}>
    {data.locations.length ? <>
      <div className={styles.mapPlot} data-density={density || undefined}><div className={styles.mapCoordinates} data-map-plane="" data-density={density || undefined} role="group" aria-label="Geographic map · WGS84 equirectangular projection" onClickCapture={chooseOverlaps}>
        <svg viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path d={worldLandPath} fillRule="evenodd" className={styles.land} data-geographic-land="natural-earth-110m" />
          {showGrid && [-180,-120,-60,0,60,120,180].map(longitude => <line key={longitude} x1={(longitude+180)*2} x2={(longitude+180)*2} y1={0} y2={360} className={longitude===0 ? styles.axis : styles.gridLine}/>)}
          {showGrid && [-90,-60,-30,0,30,60,90].map(latitude => <line key={latitude} x1={0} x2={720} y1={(90-latitude)*2} y2={(90-latitude)*2} className={latitude===0 ? styles.axis : styles.gridLine}/>)}
        </svg>
        {showCoordinates && <><span className={`${styles.coordinate} ${styles.north}`}>90°N</span><span className={`${styles.coordinate} ${styles.south}`}>90°S</span>
        <span className={`${styles.coordinate} ${styles.west}`}>180°W</span><span className={`${styles.coordinate} ${styles.east}`}>180°E</span>
        <span className={`${styles.coordinate} ${styles.equator}`}>0°</span></>}
        {data.locations.map(location => <div key={location.key} data-map-location-key={location.key} className={styles.mapMarker} style={{left:`${location.x*100}%`,top:`${location.y*100}%`,"--point-size":`${location.value === null ? density ? 4 : 8 : density ? 3 + Math.sqrt(Math.abs(location.value)/maximum)*4 : 8 + Math.sqrt(Math.abs(location.value)/maximum)*12}px`,"--point-color":location.value === null ? undefined : thresholdForValue(location.value,thresholds)?.color ?? widget.color ?? "var(--gamma-chart-3)"} as CSSProperties}>
          <Inspect props={props} selectOnFocus={false} avoidWidget tabIndex={largeMap && !props.embedded ? -1 : undefined} label={`${location.label} · ${coordinate(location.latitude)}°, ${coordinate(location.longitude)}°${config.value ? ` · ${metric(location.value, unit, decimals)}` : ""}`} context={location.context} className={styles.mapPoint} details={details(location)}>
            <span className={styles.dot} data-tone={statusTone(location.status)} data-missing={config.value && location.value===null || undefined}/>
          </Inspect>
        </div>)}
      </div></div>
      {overlaps.length > 1 && <section ref={overlapPicker} tabIndex={-1} className={styles.overlapPicker} role="region" aria-label="Locations under this point" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeOverlaps() } }}>
        <header><strong>{overlaps.length} locations under this point</strong><GammaButton size="sm" variant="quiet" aria-label="Close location choices" onClick={closeOverlaps}>Close</GammaButton></header>
        <p>Choose a recorded location; coordinates are unchanged.</p>
        <div className={styles.overlapList} role="region" aria-label="Overlapping locations" tabIndex={0}>{overlaps.map(location => <Inspect key={location.key} props={props} selectOnFocus={false} label={`Inspect overlapping location ${location.label}`} context={location.context} details={details(location)} className={styles.locationRow}><span className={styles.name}>{location.label}<small>{coordinate(location.latitude)}°, {coordinate(location.longitude)}°</small></span>{config.value && <span className={styles.value}>{metric(location.value, unit, decimals)}</span>}{location.status && <Status value={location.status}/>}</Inspect>)}</div>
      </section>}
      {config.showLocations !== false && !largeMap && <div className={styles.locationList} aria-label="Location observations">
        {data.locations.map(location => <Inspect key={location.key} props={props} selectOnFocus={false} label={`Inspect location ${location.label}`} context={location.context} details={details(location)} className={styles.locationRow}>
          <span className={styles.name}>{location.label}<small>{location.latitude.toFixed(2)}°, {location.longitude.toFixed(2)}°</small></span>
          {config.value && <span className={styles.value}>{metric(location.value, unit, decimals)}</span>}
          {location.status && <Status value={location.status}/>}
        </Inspect>)}
      </div>}
      {!props.embedded && (largeMap || density && config.showLocations === false) && <details className={styles.densityLocations} open={config.showLocations !== false ? true : undefined}><summary>Explore locations{largeMap ? ` · ${data.locations.length} displayed` : ""}</summary><div className={styles.locationExplorer}>
        {largeMap && <GammaInput size="sm" aria-label="Filter locations" placeholder="Filter locations…" value={locationSearch} onChange={event => { setLocationSearch(event.target.value); setLocationPage(0) }}/>}
        <div className={styles.densityLocationList} role="region" aria-label="Location observations">{displayedLocations.map(location => <Inspect key={location.key} props={props} selectOnFocus={false} label={`Inspect location ${location.label}`} context={location.context} details={details(location)} className={styles.locationRow}><span className={styles.name}>{location.label}<small>{location.latitude.toFixed(2)}°, {location.longitude.toFixed(2)}°</small></span>{config.value && <span className={styles.value}>{metric(location.value, unit, decimals)}</span>}{location.status && <Status value={location.status}/>}</Inspect>)}{matchingLocations.length === 0 && <p className={styles.emptyLocations}>No locations match this filter.</p>}</div>
        {largeMap && <div className={styles.locationPages}><GammaButton size="sm" variant="quiet" disabled={currentPage === 0} onClick={() => setLocationPage(currentPage - 1)}>Previous</GammaButton><span aria-live="polite">{matchingLocations.length ? `${currentPage * 20 + 1}–${Math.min((currentPage + 1) * 20, matchingLocations.length)} of ${matchingLocations.length}` : "0 locations"}</span><GammaButton size="sm" variant="quiet" disabled={currentPage + 1 >= pages} onClick={() => setLocationPage(currentPage + 1)}>Next</GammaButton></div>}
      </div></details>}
      {density && config.value && widget.options?.showLegend !== false && thresholds.length > 0 && <div className={styles.mapLegend} role="group" aria-label="Location value thresholds">{thresholds.map((threshold,index) => <span key={index}><i style={{background:threshold.color}}/>{threshold.label || (index === 0 ? thresholds.length === 1 ? "All values" : `Below ${metric(thresholds[1].value,unit,decimals)}` : `≥ ${metric(threshold.value,unit,decimals)}`)}</span>)}</div>}
    </> : <EmptyState/>}
    <Notes truncated={data.frame.truncated}>{config.value && widget.options?.showLegend !== false && <span>Marker size: absolute observed value</span>}{data.invalid > 0 && <span>{data.invalid} records have missing or invalid coordinates</span>}{data.omitted > 0 && <span>{data.omitted} additional locations omitted by the point limit</span>}</Notes>
  </div>
}

export function PipelineTopology(props: WidgetRendererProps) {
  const {widget, result} = props
  const arrowId = useId()
  const config = useMemo(() => pipelineTopologyConfig.parse(widget.config ?? {}), [widget.config])
  const data = useMemo(() => result.records ? buildPipelineTopology(result.records, config) : undefined, [result.records, config])
  if (!data) return <EmptyState/>
  const unit = widget.unit || data.valueUnit, decimals = widget.options?.decimals
  const nodeById = new Map(data.nodes.map(node => [node.id, node]))
  return <div className={styles.wrapper} data-operational-chart="pipeline-topology">
    <div className={styles.caption}><span>{data.nodes.length} stages · {data.edges.length} connections</span>{data.cycles>0 && <span>{data.cycles} cyclic {data.cycles===1 ? "group" : "groups"}</span>}</div>
    {data.nodes.length ? <>
      <PipelineViewport width={data.width} height={data.height} embedded={props.embedded}><div className={styles.topologyPlane} style={{width:data.width,height:data.height}}>
        <svg width={data.width} height={data.height} aria-hidden="true"><defs><marker id={arrowId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="var(--gamma-chart-3)"/></marker></defs>
          {data.edges.map(edge => {
            const source=nodeById.get(edge.source)!,target=nodeById.get(edge.target)!,x=source.x+128,y=source.y+31,tx=target.x,ty=target.y+31
            const path=edge.source===edge.target?`M${x},${y-12} C${x+40},${y-28} ${x+40},${y+28} ${x},${y+12}`:`M${x},${y} C${x+32},${y} ${tx-32},${ty} ${tx},${ty}`
            return <path key={edge.key} d={path} fill="none" className={styles.connection} strokeDasharray={source.cyclic&&target.cyclic ? "5 4" : undefined} markerEnd={`url(#${arrowId})`}/>
          })}
        </svg>
        {data.nodes.map(node => <div key={node.id} className={styles.node} style={{left:node.x,top:node.y}}>
          <Inspect props={props} className={styles.nodeTrigger} label={`Inspect stage ${node.id}`} context={{series:node.id,value:null,labels:{node:node.id}}} details={<Detail title={node.id}><Fact label="Incoming connections">{node.incoming}</Fact><Fact label="Outgoing connections">{node.outgoing}</Fact>{node.status&&<Status value={node.status}/>}<span>{node.cyclic ? "Part of a recorded cycle" : "Recorded pipeline stage"}</span><span>Open Connections below to inspect an observed value.</span></Detail>}>
            <span className={styles.nodeHeader}><i data-tone={statusTone(node.status)} aria-hidden="true"/><span>{node.id}</span></span>
            <small>{node.incoming} in · {node.outgoing} out{node.cyclic ? " · Cycle" : ""}</small>
          </Inspect>
        </div>)}
      </div></PipelineViewport>
      <details className={styles.edgeDisclosure}><summary>Connections · {data.edges.length}</summary><div className={styles.edgeList} role="region" aria-label="Connection observations" tabIndex={props.embedded ? undefined : 0}>
        {data.edges.map(edge => <Inspect key={edge.key} props={props} label={`Inspect connection ${edge.source} to ${edge.target}: ${config.value ? metric(edge.value, unit, decimals) : `${edge.observations} observations`}`} context={edge.context} className={styles.edgeRow}
          details={<Detail title={`${edge.source} → ${edge.target}`}><Fact label={config.value ? "Sum of observed values" : "Records"}>{config.value ? metric(edge.value, unit, decimals) : edge.observations}</Fact><Fact label="Source records">{edge.observations}</Fact>{edge.status&&<Status value={edge.status}/>}<span>Duplicate directed connections are combined. Missing values remain unknown.</span></Detail>}>
          <span className={styles.name}>{edge.source}<span className={styles.muted}> → </span>{edge.target}</span>
          <span className={styles.value}>{config.value ? metric(edge.value, unit, decimals) : `${edge.observations} records`}</span>
          {edge.status&&<Status value={edge.status}/>}
        </Inspect>)}
      </div></details>
    </> : <EmptyState/>}
    <Notes truncated={data.frame.truncated}>{data.invalid>0&&<span>{data.invalid} records have missing or invalid stage names</span>}{data.merged>0&&<span>{data.merged} duplicate connections combined</span>}{(data.omittedNodes>0||data.omittedEdges>0)&&<span>Display limit: {data.omittedNodes} stages and {data.omittedEdges} connections omitted</span>}</Notes>
  </div>
}

export function IncidentCalendar(props: WidgetRendererProps) {
  const {widget, result} = props
  const config = useMemo(() => incidentCalendarConfig.parse(widget.config ?? {}), [widget.config])
  const data = useMemo(() => result.records ? buildIncidentCalendar(result.records, config) : undefined, [result.records, config])
  if (!data) return <EmptyState/>
  const unit = widget.unit || data.valueUnit, decimals = widget.options?.decimals
  const thresholds = widget.options?.thresholds ?? []
  const thresholdLabel = (threshold: typeof thresholds[number], index: number) => threshold.label || (index === 0 ? thresholds.length === 1 ? "All values" : `Below ${metric(thresholds[1].value,unit,decimals)}` : `≥ ${metric(threshold.value,unit,decimals)}`)
  return <div className={styles.wrapper} data-operational-chart="incident-calendar">
    <div className={styles.caption}><span>{config.aggregation === "count" ? "Record count" : `${config.aggregation === "sum" ? "Sum" : "Maximum"} per day`}</span><span>UTC calendar days</span></div>
    {data.months.length ? <div className={styles.calendarScroll}><div className={styles.months}>
      {data.months.map(month => <section key={month.key} className={styles.month} aria-label={month.label}><h4>{month.label}</h4>
        <div className={styles.weekdays} aria-hidden="true">{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day=><span key={day}>{day}</span>)}</div>
        <div className={styles.days}>
          {Array.from({length:month.offset},(_,index)=><span key={`blank-${index}`} aria-hidden="true"/>)}
          {month.days.map(day=>{ const threshold = config.colorMode === "thresholds" && day.value !== null ? thresholdForValue(day.value, thresholds) : undefined; const dayThreshold = threshold ? thresholdLabel(threshold, thresholds.indexOf(threshold)) : "Unmapped value"; return <div key={day.date} className={styles.day} data-observed={day.observations>0} data-missing={day.value===null} data-unknown={config.colorMode === "thresholds" && day.observations>0 && !threshold || undefined} data-threshold={threshold?.label || (threshold ? String(threshold.value) : undefined)} style={{"--day-strength":day.value===null?0:0.06+Math.abs(day.value)/Math.max(1,data.max)*.28, ...(threshold ? {"--day-color":threshold.color} : {}), ...(config.colorMode === "thresholds" && !threshold ? {"--day-strength":0} : {})} as CSSProperties}>
            <Inspect props={props} label={`${day.date}: ${day.observations ? metric(day.value, unit, decimals) : "No observations"}${day.observations && config.colorMode === "thresholds" ? ` · ${day.value === null ? "Unknown value" : dayThreshold}` : ""}`} context={day.context} className={styles.dayTrigger}
              details={<Detail title={`${day.date} · UTC`}><Fact label={config.aggregation === "count" ? "Record count" : `${config.aggregation} of recorded values`}>{day.observations ? metric(day.value,unit,decimals) : "No observations"}</Fact>{day.observations>0&&config.colorMode==="thresholds"&&<Fact label="Threshold">{day.value === null ? "Unknown value" : dayThreshold}</Fact>}<Fact label="Source records">{day.observations}</Fact>{day.labels.length>0&&<span>{day.labels.join(" · ")}</span>}{day.status&&<Status value={day.status}/>}<span>{day.observations ? "Aggregated from records in this UTC day." : "No source records for this day; this is not a healthy or zero observation."}</span></Detail>}>
              <span>{Number(day.date.slice(-2))}</span>{day.observations>0&&<i aria-hidden="true"/>}
            </Inspect>
          </div>})}
        </div>
      </section>)}
    </div></div> : <EmptyState/>}
    {widget.options?.showLegend!==false&&data.months.length>0&&<div className={styles.calendarLegend}><span><i className={styles.missingSwatch}/>No observations</span>{config.colorMode === "thresholds" ? <><span><i className={styles.unknownSwatch}/>Unknown or unmapped value</span>{thresholds.map((threshold,index)=><span key={index}><i className={styles.thresholdSwatch} style={{"--day-color":threshold.color} as CSSProperties}/>{thresholdLabel(threshold,index)}</span>)}</> : <><span><i className={styles.recordedSwatch}/>Recorded day</span><span>Color intensity: absolute {config.aggregation === "count" ? "count" : config.aggregation}</span></>}</div>}
    <Notes truncated={data.frame.truncated}>{data.invalid>0&&<span>{data.invalid} records have missing or invalid dates</span>}{data.outside>0&&<span>{data.outside} observations are outside the displayed months</span>}</Notes>
  </div>
}

/** Bundled renderers only. Persisted configuration maps scalar columns; it cannot load code. */
export function registerOperationalRecordPlugins() {
  const entries: Omit<WidgetPlugin, "dataKind">[] = [
    {id:"connection-map",label:"Connection map",description:"Plot supplied geographic coordinates with exact record inspection",render:ConnectionMap,parseConfig:(config:unknown)=>connectionMapConfig.parse(config??{}),
      defaultConfig:{latitude:"latitude",longitude:"longitude",label:"label",display:"markers",showLocations:true},
      styleControls:["unit","decimals","legend","tooltips","color"],
      configFields:[{key:"latitude",label:"Latitude field",kind:"text" as const},{key:"longitude",label:"Longitude field",kind:"text" as const},{key:"label",label:"Location label field",kind:"text" as const},{key:"value",label:"Value field",kind:"text" as const,help:"Optional numeric field; marker size represents its absolute value."},{key:"status",label:"Status field",kind:"text" as const},{key:"display",label:"Map display",kind:"select" as const,options:[{value:"markers",label:"Markers"},{value:"density",label:"Observation glow"}],help:"Glow marks the supplied locations; it does not interpolate data between them."},{key:"showGrid",label:"Show coordinate grid",kind:"boolean" as const},{key:"showCoordinates",label:"Show coordinate labels",kind:"boolean" as const},{key:"showLocations",label:"Show location list",kind:"boolean" as const,help:"Hide the list to give the map more room. Points still expose exact observations."},{key:"maxPoints",label:"Maximum locations",kind:"number" as const,min:1,max:500}]},
    {id:"pipeline-topology",label:"Pipeline topology",description:"Follow recorded directed connections, including cycles and missing values",render:PipelineTopology,parseConfig:(config:unknown)=>pipelineTopologyConfig.parse(config??{}),
      defaultConfig:{source:"source",target:"target"},
      styleControls:["unit","decimals","tooltips"],
      configFields:[{key:"source",label:"Source stage field",kind:"text" as const},{key:"target",label:"Target stage field",kind:"text" as const},{key:"value",label:"Connection value field",kind:"text" as const,help:"Optional numeric field. Duplicate connections sum their values; missing values remain unknown."},{key:"status",label:"Status field",kind:"text" as const},{key:"maxNodes",label:"Maximum stages",kind:"number" as const,min:2,max:64},{key:"maxEdges",label:"Maximum connections",kind:"number" as const,min:1,max:200}]},
    {id:"incident-calendar",label:"Incident calendar",description:"Aggregate recorded events by UTC day without inventing healthy days",render:IncidentCalendar,parseConfig:(config:unknown)=>incidentCalendarConfig.parse(config??{}),
      defaultConfig:{date:"date",aggregation:"count",months:3},
      styleControls:["unit","decimals","legend","tooltips"],
      configFields:[{key:"date",label:"Date field",kind:"text" as const},{key:"value",label:"Value field",kind:"text" as const},{key:"label",label:"Event label field",kind:"text" as const},{key:"status",label:"Status field",kind:"text" as const},{key:"aggregation",label:"Daily aggregation",kind:"select" as const,options:[{value:"count",label:"Count records"},{value:"sum",label:"Sum values"},{value:"max",label:"Maximum value"}]},{key:"colorMode",label:"Day colors",kind:"select" as const,options:[{value:"intensity",label:"Value intensity"},{value:"thresholds",label:"Value thresholds"}],help:"Threshold colors apply to the aggregated value; missing observations stay unknown."},{key:"months",label:"Months",kind:"number" as const,min:1,max:6},{key:"endDate",label:"End month date",kind:"text" as const,placeholder:"YYYY-MM-DD",help:"Optional. Otherwise the latest recorded UTC date anchors the displayed months."}]},
  ]
  for(const entry of entries) if(!getWidgetDefinition("plugin",entry.id)) registerWidgetPlugin({...entry,dataKind:"records"})
}
