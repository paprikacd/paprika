import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildGeoHeatmap, geoHeatmapConfig } from "./geo-heatmap-data"
import { GeoHeatmap, registerGeoHeatmapPlugin } from "./geo-heatmap"
import { getWidgetDefinition } from "../widget-registry"
import type { QueryResult, Widget } from "../schema"
import { TooltipQueryProvider } from "../tooltip-query"
import { SavedQueryLibraryProvider } from "../saved-query-context"
import { TooltipWidgetDataProvider } from "../tooltip-widget-data"
import { registerRecordWidgetPlugins } from "./records"

afterEach(cleanup)
const result: QueryResult = { records: { columns: [{ key:"label",type:"string" }, { key:"latitude",type:"number" }, { key:"longitude",type:"number" }, { key:"requests",type:"number" }, { key:"service",type:"string" }], rows: [["Melbourne A",-37.81,144.96,10,"api"],["Melbourne B",-37.82,144.97,20,"api"],["London",51.5,-.12,4,"web"],["Missing",100,10,7,"api"]] } }
const widget: Widget = { id:"geo", title:"Regional requests", type:"plugin", pluginId:"geo-heatmap", dataKind:"records", providerId:"records", query:"records", unit:"", layout:{x:0,y:0,w:6,h:5}, options:{decimals:2}, config:{mode:"map",value:"requests",aggregation:"sum"} }
describe("geo heatmap", () => {
  it("bins nearby points once, aggregating finite values and preserving only shared labels", () => {
    const data = buildGeoHeatmap(result.records!, geoHeatmapConfig.parse(widget.config))
    expect(data.invalid).toBe(1)
    expect(data.cells).toHaveLength(2)
    const group = data.cells.find(cell => cell.count === 2)!
    expect(group.value).toBe(30)
    expect(group.labels).toEqual({service:"api"})
    expect(data.min).toBe(4); expect(data.max).toBe(30)
  })
  it("keeps partial aggregates unknown instead of treating missing values as zero", () => {
    const data = buildGeoHeatmap({ ...result.records!, rows:[["A",-37.81,144.96,2,"api"],["B",-37.82,144.97,null,"api"]] }, geoHeatmapConfig.parse({value:"requests",aggregation:"mean"}))
    expect(data.cells[0].value).toBeNull(); expect(data.cells[0].missing).toBe(1)
  })
  it("makes grid cells represent input rows, not inferred geographic bins", () => {
    const data = buildGeoHeatmap(result.records!, geoHeatmapConfig.parse({mode:"grid",value:"requests",aggregation:"mean",maxRecords:3}))
    expect(data.cells.map(cell => cell.value)).toEqual([10,20,4]); expect(data.omitted).toBe(1)
  })
  it("staggered grid wraps to the configured number of columns without changing values", () => {
    const rows = Array.from({length:9}, (_, index) => [`point ${index}`, 0, 0, index, "api"])
    const data = buildGeoHeatmap({ ...result.records!, rows }, geoHeatmapConfig.parse({mode:"grid",value:"requests",aggregation:"mean",gridColumns:8}))
    expect(data.cells[0].y).toBe(data.cells[7].y)
    expect(data.cells[8].y).toBeGreaterThan(data.cells[7].y)
    expect(data.cells[8].x).toBeGreaterThan(data.cells[0].x)
    const radius = 684 / 8 / Math.sqrt(3)
    expect(data.cells[0].x - Math.sqrt(3) * radius / 2).toBeGreaterThanOrEqual(4)
    expect(data.cells[0].y - radius).toBeGreaterThanOrEqual(4)
    expect(data.cells.map(cell => cell.value)).toEqual([0,1,2,3,4,5,6,7,8])
  })
  it("exposes bounded config and clear authoring controls", () => {
    expect(geoHeatmapConfig.safeParse({aggregation:"sum"}).success).toBe(false)
    expect(geoHeatmapConfig.safeParse({radius:100}).success).toBe(false)
    registerGeoHeatmapPlugin()
    expect(getWidgetDefinition("plugin","geo-heatmap")?.configFields?.some(field => field.key === "mode")).toBe(true)
  })
  it("offers accessible cell details, pinned tooltips, and no false interpolation", () => {
    const {container} = render(<GeoHeatmap widget={widget} result={result}/>)
    expect(container.querySelectorAll("[data-geo-cell]")).toHaveLength(2)
    const target = screen.getByRole("button",{name:/2 observations · Sum of requests: 30.00 · 2 records/})
    fireEvent.focus(target)
    expect(screen.getByRole("tooltip")).toHaveTextContent("Nearby locations grouped")
    expect(screen.getByRole("tooltip")).toHaveTextContent("service: api")
    fireEvent.click(target); expect(target).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText(/empty areas are unobserved/)).toBeInTheDocument()
    expect(screen.getByText("1 invalid coordinates omitted")).toBeInTheDocument()
  })
  it("activates shared bin context only on click, never hover or focus", () => {
    const select = vi.fn()
    render(<GeoHeatmap widget={widget} result={result} onContextChange={select} />)
    const target = screen.getByRole("button", {name:/2 observations · Sum of requests/})
    fireEvent.pointerEnter(target, { pointerType: "mouse" }); fireEvent.focus(target)
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(target)
    expect(select).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith({ labels: { service:"api" }, value:30, series:"2 observations" })
  })
  it("queries configured tooltip data from shared labels and exact aggregated value only while open", async () => {
    const fetcher = vi.fn().mockResolvedValue({ series:[{ name:"rate",labels:{},points:[{timestamp:1500000,value:4}]}] })
    const linked: Widget = { ...widget, options:{...widget.options, tooltipView:{ type:"stat", source:{ type:"query", providerId:"prom", query:"rate{service={{service}}} > {{amount}}", bindings:[{variable:"service",label:"service"},{variable:"amount",field:"value"}] } }} }
    render(<TooltipQueryProvider fetcher={fetcher} providers={[{id:"prom",name:"Metrics",type:"prometheus",capabilities:["metrics"]}]} start={1000} end={2000} step={15}><GeoHeatmap widget={linked} result={result}/></TooltipQueryProvider>)
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.focus(screen.getByRole("button",{name:/2 observations · Sum of requests/}))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0][0]).toMatchObject({providerId:"prom",kind:"metrics",query:'rate{service="api"} > 30'})
  })
  it("does not query when a grouped label or nonexistent timestamp is requested", async () => {
    for (const binding of [{variable:"key",label:"label"}, {variable:"key",field:"timestamp" as const}]) {
      const fetcher = vi.fn()
      const linked: Widget = { ...widget, options:{ tooltipView:{type:"stat",source:{type:"query",providerId:"prom",query:"up > {{key}}",bindings:[binding]}}} }
      const view = render(<TooltipQueryProvider fetcher={fetcher} providers={[{id:"prom",name:"Metrics",type:"prometheus",capabilities:["metrics"]}]} start={1000} end={2000} step={15}><GeoHeatmap widget={linked} result={result}/></TooltipQueryProvider>)
      fireEvent.focus(screen.getByRole("button",{name:/2 observations · Sum of requests/}))
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no label|no valid timestamp/))
      expect(fetcher).not.toHaveBeenCalled()
      view.unmount()
    }
  })
  it("resolves a saved tooltip query from the selected record's exact label", async () => {
    const fetcher = vi.fn().mockResolvedValue({ series:[{name:"value",labels:{},points:[{timestamp:1500000,value:4}]}] })
    const linked: Widget = { ...widget, config:{mode:"grid",value:"requests",aggregation:"mean"}, options:{tooltipView:{type:"stat",source:{type:"saved",ref:{id:"service-rate",bindings:[{parameter:"service",source:"label",label:"service"}]}}}} }
    const saved = {schemaVersion:1 as const,id:"service-rate",name:"Service rate",providerId:"prom",kind:"metrics" as const,query:"rate{service={{service}}}",parameters:[{name:"service",type:"string" as const}]}
    render(<SavedQueryLibraryProvider queries={[saved]} values={{}} variables={[]}><TooltipQueryProvider fetcher={fetcher} providers={[{id:"prom",name:"Metrics",type:"prometheus",capabilities:["metrics"]}]} start={1000} end={2000} step={15}><GeoHeatmap widget={linked} result={result}/></TooltipQueryProvider></SavedQueryLibraryProvider>)
    fireEvent.focus(screen.getByRole("button",{name:/London · Mean of requests/}))
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0][0]).toMatchObject({query:'rate{service="web"}',kind:"metrics"})
  })
  it("reuses the bounded parent record result without issuing a query or implying it is filtered to the hex", () => {
    registerRecordWidgetPlugins()
    const fetcher = vi.fn()
    const records = { ...result.records!, rows: Array.from({length:12}, (_, index) => [`Place ${index}`, index, index, index, "api"]) }
    const linked: Widget = { ...widget, config:{mode:"grid",value:"requests",aggregation:"mean"}, options:{tooltipView:{type:"plugin",pluginId:"record-table",dataKind:"records",config:{columns:["label"],showSearch:false},source:{type:"widget"}}} }
    render(<TooltipWidgetDataProvider kind="records" result={{records}}><TooltipQueryProvider fetcher={fetcher} providers={[]} start={1000} end={2000} step={15}><GeoHeatmap widget={linked} result={{records}}/></TooltipQueryProvider></TooltipWidgetDataProvider>)
    fireEvent.focus(screen.getByRole("button",{name:/Place 0 · Mean of requests/}))
    const tooltip = screen.getByRole("tooltip")
    expect(within(tooltip).getByText("Place 1")).toBeInTheDocument()
    expect(within(tooltip).queryByText("Place 10")).not.toBeInTheDocument()
    expect(within(tooltip).getByText(/Partial result/)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
