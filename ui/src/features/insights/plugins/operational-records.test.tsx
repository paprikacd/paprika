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
  it("lets a pointer choose any overlapping recorded marker without moving it",()=>{
    const select=vi.fn()
    const result:QueryResult={records:{...locations.records!,rows:[["Melbourne",-37.81,144.96,123.456,"api"],["Melbourne west",-37.811,144.961,55,"worker"]]}}
    const {container}=render(<ConnectionMap widget={{...widget,config:{value:"value",showLocations:false}}} result={result} onContextChange={select}/>)
    const first=screen.getByRole("button",{name:/^Melbourne ·/}), second=screen.getByRole("button",{name:/^Melbourne west ·/})
    const plane=container.querySelector("[data-map-plane]")!
    Object.defineProperty(document,"elementsFromPoint",{configurable:true,value:vi.fn(()=>[second,first,plane])})
    try {
      fireEvent.click(second,{detail:1,clientX:20,clientY:30})
      expect(select).not.toHaveBeenCalled()
      const chooser=screen.getByRole("region",{name:"Locations under this point"})
      expect(chooser).toHaveTextContent("2 locations")
      fireEvent.click(screen.getByRole("button",{name:"Inspect overlapping location Melbourne"}))
      expect(select).toHaveBeenLastCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
      fireEvent.click(screen.getByRole("button",{name:"Inspect overlapping location Melbourne west"}))
      expect(select).toHaveBeenLastCalledWith({series:"Melbourne west",value:55,labels:{label:"Melbourne west",latitude:"-37.811",longitude:"144.961",value:"55",service:"worker"}})
      fireEvent.click(screen.getByRole("button",{name:"Close location choices"}))
      expect(screen.queryByRole("region",{name:"Locations under this point"})).not.toBeInTheDocument()
      expect(second).toHaveFocus()
      fireEvent.click(second,{detail:1,clientX:20,clientY:30})
      const reopened=screen.getByRole("region",{name:"Locations under this point"})
      expect(reopened).toHaveFocus()
      fireEvent.keyDown(reopened,{key:"Escape"})
      expect(screen.queryByRole("region",{name:"Locations under this point"})).not.toBeInTheDocument()
      expect(second).toHaveFocus()
      fireEvent.click(second,{detail:0})
      expect(select).toHaveBeenLastCalledWith({series:"Melbourne west",value:55,labels:{label:"Melbourne west",latitude:"-37.811",longitude:"144.961",value:"55",service:"worker"}})
      expect(screen.queryByRole("region",{name:"Locations under this point"})).not.toBeInTheDocument()
    } finally { delete (document as unknown as {elementsFromPoint?:unknown}).elementsFromPoint }
  })
  it("positions map marker details outside the owning widget",()=>{
    vi.stubGlobal("innerWidth",1024); vi.stubGlobal("innerHeight",768)
    const bounds=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){
      if(this.dataset.widgetId==="owner")return new DOMRect(100,200,500,250)
      if(this.getAttribute("role")==="tooltip")return new DOMRect(0,0,200,100)
      return new DOMRect(200,250,20,20)
    })
    try{
      render(<article data-widget-id="owner"><ConnectionMap widget={{...widget,config:{value:"value",showLocations:false}}} result={locations}/></article>)
      fireEvent.focus(screen.getByRole("button",{name:/Melbourne.*123.46/}))
      expect(Number.parseFloat(screen.getByRole("tooltip").style.left)).toBeGreaterThanOrEqual(610)
    }finally{bounds.mockRestore();vi.unstubAllGlobals()}
  })
  it("renders precise density observations with threshold colors and explicit selection",()=>{
    const select=vi.fn()
    const result:QueryResult={records:{...locations.records!,rows:[["Melbourne",-37.81,144.96,123.456,"api"],["Sydney",-33.86,151.2,null,"api"]]}}
    const {container}=render(<ConnectionMap widget={{...widget,config:{value:"value",display:"density",showLocations:false},options:{decimals:2,thresholds:[{value:0,color:"#00cadd",label:"Low"},{value:100,color:"#f5ab2f",label:"Medium"},{value:200,color:"#f54c40",label:"High"}]}}} result={result} onContextChange={select}/>)
    expect(container.querySelectorAll('[data-map-plane] line')).toHaveLength(0)
    expect(screen.queryByText("90°N")).not.toBeInTheDocument()
    const marker=screen.getByRole("button",{name:"Melbourne · -37.81°, 144.96° · 123.46"})
    expect(marker.parentElement).toHaveStyle({"--point-color":"#f5ab2f"})
    expect(screen.getByRole("group",{name:"Location value thresholds"})).toHaveTextContent("Medium")
    expect(screen.getByRole("button",{name:/^Sydney ·/}).querySelector('[data-missing="true"]')).toBeInTheDocument()
    fireEvent.focus(marker)
    expect(select).not.toHaveBeenCalled()
    expect(screen.getByRole("tooltip")).toHaveTextContent("123.46")
    fireEvent.click(marker)
    expect(select).toHaveBeenCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
    expect(screen.getByText("Explore locations")).toBeInTheDocument()
  })
  it("keeps a dense map keyboard-reachable through bounded, searchable observations",()=>{
    const select=vi.fn()
    const rows=Array.from({length:50},(_,index)=>[`Point ${index+1}`, -73.55000000000001, 144.96, index, "api"])
    const result:QueryResult={records:{...locations.records!,rows}}
    const {container}=render(<ConnectionMap widget={{...widget,config:{value:"value",display:"density",showLocations:false}}} result={result} onContextChange={select}/>)
    const markers=[...container.querySelectorAll('[data-map-plane] button')]
    expect(markers).toHaveLength(50)
    expect(markers.every(marker=>marker.getAttribute("tabindex")==="-1")).toBe(true)
    expect(markers[0]).toHaveAccessibleName("Point 1 · -73.55°, 144.96° · 0.00")
    fireEvent.click(screen.getByText("Explore locations · 50 displayed"))
    expect(screen.getByText("1–20 of 50")).toBeInTheDocument()
    expect(screen.getAllByRole("button",{name:/^Inspect location Point /})).toHaveLength(20)
    fireEvent.click(screen.getByRole("button",{name:"Next"}))
    expect(screen.getByText("21–40 of 50")).toBeInTheDocument()
    expect(screen.getByRole("button",{name:"Inspect location Point 21"})).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox",{name:"Filter locations"}),{target:{value:"Point 49"}})
    const selected=screen.getByRole("button",{name:"Inspect location Point 49"})
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument()
    fireEvent.focus(selected)
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(selected)
    expect(select).toHaveBeenLastCalledWith({series:"Point 49",value:48,labels:{label:"Point 49",latitude:"-73.55000000000001",longitude:"144.96",value:"48",service:"api"}})
    fireEvent.change(screen.getByRole("textbox",{name:"Filter locations"}),{target:{value:"unmatched"}})
    expect(screen.getByText("No locations match this filter.")).toBeInTheDocument()
  })
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
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(marker)
    expect(select).toHaveBeenLastCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
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
  it("shows the correct grid defaults for legacy and density maps in guided authoring",()=>{
    registerOperationalRecordPlugins()
    const definition=getWidgetDefinition("plugin","connection-map"), change=vi.fn()
    const view=render(<PluginConfigEditor definition={definition} value="{}" onChange={change}/>)
    expect(screen.getByRole("switch",{name:"Show coordinate grid"})).toBeChecked()
    expect(screen.getByRole("switch",{name:"Show coordinate labels"})).toBeChecked()
    view.rerender(<PluginConfigEditor definition={definition} value={'{"display":"density"}'} onChange={change}/>)
    expect(screen.getByRole("switch",{name:"Show coordinate grid"})).not.toBeChecked()
    expect(screen.getByRole("switch",{name:"Show coordinate labels"})).not.toBeChecked()
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
  it("announces vertical overflow even when the full pipeline fits horizontally",()=>{
    render(<PipelineTopology widget={{...widget,pluginId:"pipeline-topology",config:{value:"value"}}} result={edges}/>)
    const viewport=screen.getByRole("region",{name:"Pipeline diagram"})
    Object.defineProperties(viewport,{scrollWidth:{value:440},clientWidth:{value:440},scrollHeight:{value:400},clientHeight:{value:150}})
    fireEvent.scroll(viewport)
    const hint=screen.getByText("Scroll to explore all stages vertically")
    expect(viewport).toHaveAttribute("aria-describedby",hint.id)
    expect(screen.queryByRole("button",{name:"Next pipeline stages"})).toBeNull()
  })
  it("allows a location to be inspected and selected with exact record labels",()=>{
    const select=vi.fn();render(<ConnectionMap widget={{...widget,config:{value:"value"}}} result={locations} onContextChange={select}/>)
    expect(screen.getByText("1 records have missing or invalid coordinates")).toBeInTheDocument()
    const location=screen.getByRole("button",{name:"Inspect location Melbourne"})
    fireEvent.focus(location)
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(location)
    expect(select).toHaveBeenCalledWith({series:"Melbourne",value:123.456,labels:{label:"Melbourne",latitude:"-37.81",longitude:"144.96",value:"123.456",service:"api"}})
    expect(screen.getByRole("tooltip")).toHaveTextContent("123.46")
    expect(screen.getByRole("tooltip")).toHaveTextContent("144.9600°")
  })
  it("offers exact summed connection inspection and a non-numeric stage context",()=>{
    const select=vi.fn();render(<PipelineTopology widget={{...widget,pluginId:"pipeline-topology",config:{value:"value"}}} result={edges} onContextChange={select}/>)
    fireEvent.click(screen.getByText("Connections · 1"))
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
  it("colors aggregated days by configured thresholds while preserving unknown and unobserved days",()=>{
    const result:QueryResult={records:{columns:[{key:"date",type:"string"},{key:"value",type:"number"},{key:"status",type:"string"}],rows:[["2026-10-02",1,"warning"],["2026-10-03",1,"warning"],["2026-10-03",2,"critical"],["2026-10-04",null,"unknown"],["2026-10-04",2,"critical"]]}}
    const options={...widget.options,thresholds:[{value:1,color:"#eab640",label:"Warning"},{value:2,color:"#e8554e",label:"Critical"}]}
    render(<IncidentCalendar widget={{...widget,pluginId:"incident-calendar",config:{value:"value",status:"status",aggregation:"max",colorMode:"thresholds",months:1},options}} result={result}/>)
    expect(screen.getByRole("button",{name:"2026-10-01: No observations"}).parentElement).toHaveAttribute("data-observed","false")
    expect(screen.getByRole("button",{name:"2026-10-02: 1.00 · Warning"}).parentElement).toHaveAttribute("data-threshold","Warning")
    expect(screen.getByRole("button",{name:"2026-10-03: 2.00 · Critical"}).parentElement).toHaveAttribute("data-threshold","Critical")
    const unknown=screen.getByRole("button",{name:"2026-10-04: No observed value · Unknown value"})
    expect(unknown.parentElement).toHaveAttribute("data-observed","true")
    expect(unknown.parentElement).toHaveAttribute("data-unknown","true")
    expect(screen.getByRole("button",{name:"2026-10-01: No observations"}).parentElement).not.toHaveAttribute("data-unknown")
    expect(unknown.parentElement).not.toHaveAttribute("data-threshold")
    expect(screen.getByText("Unknown or unmapped value")).toBeInTheDocument()
  })
  it("labels the first threshold as a baseline, including values below its boundary",()=>{
    const result:QueryResult={records:{columns:[{key:"date",type:"string"},{key:"value",type:"number"}],rows:[["2026-10-02",0]]}}
    const config={value:"value",aggregation:"max",colorMode:"thresholds",months:1}
    const options={...widget.options,thresholds:[{value:1,color:"#eab640"},{value:2,color:"#e8554e"}]}
    const {rerender}=render(<IncidentCalendar widget={{...widget,pluginId:"incident-calendar",config,options}} result={result}/>)
    expect(screen.getByRole("button",{name:"2026-10-02: 0.00 · Below 2.00"})).toBeInTheDocument()
    expect(screen.getByText("Below 2.00")).toBeInTheDocument()
    rerender(<IncidentCalendar widget={{...widget,pluginId:"incident-calendar",config,options:{...options,thresholds:[]}}} result={result}/>)
    expect(screen.getByRole("button",{name:"2026-10-02: 0.00 · Unmapped value"}).parentElement).toHaveAttribute("data-unknown","true")
    expect(screen.getByRole("button",{name:"2026-10-02: 0.00 · Unmapped value"}).parentElement).not.toHaveAttribute("data-threshold")
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
