import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionMap, IncidentCalendar, PipelineTopology, registerOperationalRecordPlugins } from "./operational-records"
import { getWidgetDefinition } from "../widget-registry"
import { PluginConfigEditor } from "../plugin-config-editor"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)
const widget: Widget={id:"operational",title:"Operational records",type:"plugin",pluginId:"connection-map",dataKind:"records",providerId:"records",query:"records",unit:"",layout:{x:0,y:0,w:6,h:5},options:{decimals:2}}
const locations: QueryResult={records:{columns:[{key:"label",type:"string"},{key:"latitude",type:"number"},{key:"longitude",type:"number"},{key:"value",type:"number"},{key:"service",type:"string"}],rows:[["Melbourne",-37.81,144.96,123.456,"api"],["Unknown",null,null,1,"api"]]}}
const edges: QueryResult={records:{columns:[{key:"source",type:"string"},{key:"target",type:"string"},{key:"value",type:"number"}],rows:[["source","collector",1.111],["source","collector",2.222]]}}

describe("operational record renderers",()=>{
  it("keeps map markers in the same geographic plane as the preserved world projection",()=>{
    const {container}=render(<ConnectionMap widget={widget} result={locations}/>)
    const plane=container.querySelector("[data-map-plane]")!
    expect(plane.querySelector("svg")).toHaveAttribute("preserveAspectRatio","xMidYMid meet")
    const marker=screen.getByRole("button",{name:/Melbourne · -37.81°, 144.96°/}).parentElement!
    expect(marker.parentElement).toBe(plane)
    expect(parseFloat(marker.style.left)).toBeCloseTo((144.96+180)/360*100)
    expect(parseFloat(marker.style.top)).toBeCloseTo((90+37.81)/180*100)
  })
  it("keeps exact marker inspection and selection when the location list is hidden",()=>{
    const select=vi.fn()
    render(<ConnectionMap widget={{...widget,config:{value:"value",showLocations:false}}} result={locations} onContextChange={select}/>)
    expect(screen.queryByLabelText("Location observations")).not.toBeInTheDocument()
    expect(screen.queryByRole("button",{name:"Inspect location Melbourne"})).not.toBeInTheDocument()
    const marker=screen.getByRole("button",{name:"Melbourne · -37.81°, 144.96° · 123.46"})
    fireEvent.focus(marker)
    expect(screen.getByRole("tooltip")).toHaveTextContent("144.9600°")
    expect(screen.getByRole("tooltip")).toHaveTextContent("api")
    expect(select).toHaveBeenLastCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
    fireEvent.click(marker)
    expect(marker).toHaveAttribute("aria-pressed","true")
    fireEvent.keyDown(document,{key:"Escape"})
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    expect(screen.getByText("1 records have missing or invalid coordinates")).toBeInTheDocument()
  })
  it("shows the location-list switch checked for legacy maps whose list is visible",()=>{
    registerOperationalRecordPlugins()
    const change=vi.fn()
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin","connection-map")} value="{}" onChange={change}/>)
    const toggle=screen.getByRole("switch",{name:/Show location list/})
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    expect(JSON.parse(change.mock.calls.at(-1)![0])).toEqual({showLocations:false})
  })
  it("offers explicit navigation only when the pipeline overflows and preserves keyboard access",()=>{
    render(<PipelineTopology widget={{...widget,pluginId:"pipeline-topology",config:{value:"value"}}} result={edges}/>)
    const viewport=screen.getByRole("region",{name:"Pipeline diagram"})
    expect(viewport).toHaveAttribute("tabindex","0")
    expect(screen.queryByRole("button",{name:"Next pipeline stages"})).toBeNull()
    Object.defineProperties(viewport,{scrollWidth:{value:1200},clientWidth:{value:300},scrollLeft:{value:0,writable:true}})
    const scrollBy=vi.fn((options?: ScrollToOptions | number)=>{viewport.scrollLeft+=typeof options === "number" ? options : options?.left ?? 0;fireEvent.scroll(viewport)})
    viewport.scrollBy=scrollBy
    fireEvent.scroll(viewport)
    expect(screen.getByText("Scroll to explore all stages")).toBeInTheDocument()
    expect(screen.getByRole("button",{name:"Previous pipeline stages"})).toBeDisabled()
    fireEvent.click(screen.getByRole("button",{name:"Next pipeline stages"}))
    expect(scrollBy).toHaveBeenCalledWith({left:240})
    expect(screen.getByRole("button",{name:"Previous pipeline stages"})).not.toBeDisabled()
    viewport.scrollLeft=900;fireEvent.scroll(viewport)
    expect(screen.getByRole("button",{name:"Next pipeline stages"})).toBeDisabled()
  })
  it("allows a location to be inspected and selected with exact record labels",()=>{
    const select=vi.fn();render(<ConnectionMap widget={{...widget,config:{value:"value"}}} result={locations} onContextChange={select}/>)
    expect(screen.getByText("1 records have missing or invalid coordinates")).toBeInTheDocument()
    fireEvent.focus(screen.getByRole("button",{name:"Inspect location Melbourne"}))
    expect(select).toHaveBeenCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
    expect(screen.getByRole("tooltip")).toHaveTextContent("123.46")
    expect(screen.getByRole("tooltip")).toHaveTextContent("144.9600°")
  })
  it("offers exact summed connection inspection and a non-numeric stage context",()=>{
    const select=vi.fn();render(<PipelineTopology widget={{...widget,pluginId:"pipeline-topology",config:{value:"value"}}} result={edges} onContextChange={select}/>)
    fireEvent.click(screen.getByRole("button",{name:/Inspect connection source to collector/}))
    expect(select).toHaveBeenLastCalledWith({series:"source → collector",value:3.333,labels:{source:"source",target:"collector"}})
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sum of observed values")
    fireEvent.click(screen.getByRole("button",{name:"Inspect stage collector"}))
    expect(select).toHaveBeenLastCalledWith({series:"collector",value:null,labels:{node:"collector"}})
  })
  it("shows missing days separately and emits the exact aggregated calendar value",()=>{
    const select=vi.fn(),result:QueryResult={records:{columns:[{key:"date",type:"string"},{key:"value",type:"number"}],rows:[["2026-10-03",2.123],["2026-10-03",3.456],["2026-10-04",0]]}}
    render(<IncidentCalendar widget={{...widget,pluginId:"incident-calendar",config:{value:"value",aggregation:"sum",months:1}}} result={result} onContextChange={select}/>)
    expect(screen.getByRole("button",{name:"2026-10-02: No observations"})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:"2026-10-04: 0.00"})).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button",{name:"2026-10-03: 5.58"}))
    expect(select).toHaveBeenLastCalledWith({series:"2026-10-03",value:5.579000000000001,labels:{date:"2026-10-03",aggregation:"sum",observations:"2"}})
  })
  it("renders embedded data without nested controls or callbacks",()=>{
    const select=vi.fn();const {container}=render(<ConnectionMap widget={{...widget,config:{value:"value"}}} result={locations} onContextChange={select} embedded/>)
    expect(screen.queryByRole("button")).not.toBeInTheDocument();expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.click(container.querySelector('[data-operational-chart="connection-map"]')!)
    expect(select).not.toHaveBeenCalled()
  })
  it("keeps source truncation and configured coordinate limits visible",()=>{
    render(<ConnectionMap widget={{...widget,config:{maxPoints:1}}} result={{records:{...locations.records!,rows:[["A",0,0,0,"api"],["B",1,1,1,"api"]],truncated:true}}}/>)
    expect(screen.getByText("Partial result · source limit reached")).toBeInTheDocument()
    expect(screen.getByText("1 additional locations omitted by the point limit")).toBeInTheDocument()
  })
})
