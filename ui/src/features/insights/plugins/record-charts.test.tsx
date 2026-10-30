import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordBar, RecordLine } from "./record-charts"
import type { QueryResult, Widget } from "../schema"
import { DashboardWindowProvider } from "../dashboard-window"

afterEach(cleanup)
const widget: Widget = { id:"chart",title:"Service observations",type:"plugin",pluginId:"records-line",dataKind:"records",providerId:"uptime",query:"records",unit:"",layout:{x:0,y:0,w:6,h:4},options:{decimals:2},config:{x:"service",y:["uptime"]} }
const frame = (rows: NonNullable<QueryResult["records"]>["rows"]): QueryResult => ({records:{columns:[{key:"service",type:"string"},{key:"uptime",type:"number",unit:"percent"}],rows}})

describe("record charts", () => {
  it.each([{rows:[["api",12]]},{rows:[["api",12],["worker",24],["web",6]]}])("keeps every complete bar inside the plot, including singleton and edge categories", ({rows}) => {
    const {container} = render(<RecordBar widget={widget} result={frame(rows as NonNullable<QueryResult["records"]>["rows"])} />)
    const clip = container.querySelector("clipPath rect")!
    const left = Number(clip.getAttribute("x")), right = left + Number(clip.getAttribute("width"))
    const bars = screen.getAllByRole("img")
    expect(bars).toHaveLength(rows.length)
    for (const bar of bars) {
      const x = Number(bar.getAttribute("x")), width = Number(bar.getAttribute("width"))
      expect(width).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(left)
      expect(x+width).toBeLessThanOrEqual(right)
    }
    if (rows.length === 1) expect(Number(bars[0].getAttribute("x"))+Number(bars[0].getAttribute("width"))/2).toBe(300)
  })
  it("breaks the line at missing observations and selects the exact unrounded record", () => {
    const select = vi.fn()
    const {container} = render(<RecordLine widget={widget} result={frame([["api",0],["worker",null],["web",98.217]])} onContextChange={select} />)
    const path = container.querySelector('path[fill="none"]')!.getAttribute("d")!
    expect(path.match(/M/g)).toHaveLength(2)
    expect(path).not.toContain("L")
    expect(screen.getByRole("button",{name:"uptime · api · 0.00%"})).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole("button",{name:"uptime · web · 98.22%"}),{key:"Enter"})
    expect(select).toHaveBeenCalledWith({series:"uptime",value:98.217,labels:{service:"web",uptime:"98.217"}})
    expect(screen.queryByRole("button",{name:/worker/})).not.toBeInTheDocument()
  })
  it.each([RecordLine,RecordBar])("keeps extreme finite signed values on a finite, ordered vertical scale", (Component) => {
    const {container}=render(<Component widget={widget} result={frame([["negative",-1e308],["zero",0],["positive",1e308]])} />)
    const marks=[...container.querySelectorAll<SVGElement>('[data-record-mark]')]
    expect(marks).toHaveLength(3)
    for(const mark of marks) for(const attribute of ["x","y","width","height","cx","cy"]) {
      const value=mark.getAttribute(attribute)
      if(value!==null) expect(Number.isFinite(Number(value))).toBe(true)
    }
    const path=container.querySelector('path[fill="none"]')?.getAttribute("d")
    if(path) expect(path).not.toMatch(/NaN|Infinity/)
    expect(container.textContent).not.toMatch(/NaN|Infinity/)
    if(Component===RecordLine) {
      const y=marks.map(mark=>Number(mark.getAttribute("cy")))
      expect(y[0]).toBeGreaterThan(y[1]);expect(y[1]).toBeGreaterThan(y[2])
    }
  })
  it.each([RecordLine,RecordBar])("keeps extreme finite signed coordinates distinct on the horizontal scale", (Component) => {
    const result:QueryResult={records:{columns:[{key:"x",type:"number"},{key:"value",type:"number"}],rows:[[-1e308,1],[0,2],[1e308,3]]}}
    const {container}=render(<Component widget={{...widget,config:{x:"x",y:["value"]}}} result={result}/>)
    const marks=[...container.querySelectorAll<SVGElement>('[data-record-mark]')]
    expect(marks).toHaveLength(3)
    const x=marks.map(mark=>Number(mark.getAttribute(Component===RecordLine?"cx":"x")))
    expect(x.every(Number.isFinite)).toBe(true)
    expect(x[0]).toBeLessThan(x[1]);expect(x[1]).toBeLessThan(x[2])
    expect(container.textContent).not.toMatch(/NaN|Infinity/)
  })
  it("uses separate numeric scales for the right axis and exposes annotations with exact timestamps", () => {
    const start="2026-10-27T01:00:00Z", end="2026-10-27T02:00:00Z"
    const result: QueryResult = {records:{columns:[{key:"at",type:"timestamp"},{key:"rate",label:"Rate",type:"number",unit:"req/s"},{key:"latency",label:"Latency",type:"number",unit:"ms"}],rows:[[end,1,1000],[start,0.5,500]]}}
    const config={x:"at",y:["rate","latency"],rightAxis:["latency"],annotations:[{x:start,label:"Deployment"}]}
    const {container} = render(<RecordLine widget={{...widget,config}} result={result} />)
    const rate=screen.getByRole("img",{name:"Rate · 2026-10-27T02:00:00.000Z · 1.00 req/s"})
    const latency=screen.getByRole("img",{name:"Latency · 2026-10-27T02:00:00.000Z · 1,000.00 ms"})
    expect(rate.getAttribute("cy")).toBe(latency.getAttribute("cy"))
    expect(screen.getByText("Latency (right axis)")).toBeInTheDocument()
    expect(screen.getByText("01:00")).toBeInTheDocument()
    expect(screen.getByText("02:00")).toBeInTheDocument()
    expect(container.querySelector('line[stroke-dasharray="3 3"]')).toBeInTheDocument()
    expect(screen.getAllByText("Deployment")).toHaveLength(2)
  })
  it("inspects exact record observations outside the chart without committing a selection", async () => {
    const select=vi.fn(),start="2026-10-27T01:00:00Z",end="2026-10-27T02:00:00Z"
    const result:QueryResult={records:{columns:[{key:"at",type:"timestamp"},{key:"rate",type:"number",unit:"req/s"},{key:"service",type:"string"}],rows:[[start,2.125,"api"],[end,4.5,"api"]]}}
    const {container}=render(<RecordLine widget={{...widget,config:{x:"at",y:["rate"]}}} result={result} onContextChange={select}/>)
    const chart=screen.getByRole("group",{name:widget.title})
    vi.spyOn(chart,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,600,280))
    const point=screen.getByRole("button",{name:/2026-10-27T01:00:00.*2.13/})
    fireEvent.pointerMove(chart,{clientX:Number(point.getAttribute("cx")),clientY:Number(point.getAttribute("cy")),pointerType:"mouse"})
    const tip=await screen.findByRole("tooltip")
    expect(container.contains(tip)).toBe(false)
    expect(tip).toHaveTextContent("2026-10-27T01:00:00.000Z")
    expect(tip).toHaveTextContent("2.13 req/s")
    expect(tip).toHaveTextContent("service: api")
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(point,{key:"Enter"})
    expect(select).toHaveBeenCalledWith({series:"rate",value:2.125,timestamp:Date.parse(start),labels:{at:start,rate:"2.125",service:"api"}})
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned")
  })
  it("allows keyboard inspection without a selection binding and discards the tooltip for refreshed data", async () => {
    const result=frame([["api",12],["worker",24]])
    const {rerender}=render(<RecordLine widget={widget} result={result}/>)
    const chart=screen.getByRole("group",{name:widget.title})
    fireEvent.focus(chart)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("api")
    fireEvent.keyDown(chart,{key:"ArrowRight"})
    expect(screen.getByRole("tooltip")).toHaveTextContent("worker")
    fireEvent.keyDown(chart,{key:"Enter"})
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned")
    rerender(<RecordLine widget={widget} result={frame([["api",1],["worker",2]])}/>)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("hits a line between sparse samples but shows an actual observation", async () => {
    render(<RecordLine widget={widget} result={frame([["api",10],["worker",30]])}/>)
    const chart=screen.getByRole("group",{name:widget.title})
    vi.spyOn(chart,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,600,280))
    const [a,b]=screen.getAllByRole("img")
    const x1=Number(a.getAttribute("cx")),y1=Number(a.getAttribute("cy")),x2=Number(b.getAttribute("cx")),y2=Number(b.getAttribute("cy"))
    fireEvent.pointerMove(chart,{clientX:x1+(x2-x1)*.4,clientY:y1+(y2-y1)*.4,pointerType:"mouse"})
    const tip=await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("api")
    expect(tip).toHaveTextContent("10.00%")
  })
  it("honors disabled tooltips without disabling explicit selection", async () => {
    const select=vi.fn(),result=frame([["api",10],["worker",30]])
    const {rerender}=render(<RecordLine widget={widget} result={result} onContextChange={select}/>)
    const chart=screen.getByRole("group",{name:widget.title})
    fireEvent.focus(chart)
    expect(await screen.findByRole("tooltip")).toBeInTheDocument()
    rerender(<RecordLine widget={{...widget,options:{...widget.options,showTooltip:false}}} result={result} onContextChange={select}/>)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button",{name:/uptime · api/}))
    expect(select).toHaveBeenCalledOnce()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    rerender(<RecordLine widget={widget} result={result} onContextChange={select}/>)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("retains distinct unknown and explicitly named groups and announces omitted coordinates and source limits", () => {
    const result: QueryResult={records:{columns:[{key:"at",type:"number"},{key:"value",type:"number"},{key:"group",type:"string"}],rows:[[1,1,null],[1,2,"Unknown"],[null,3,"Unknown"]],truncated:true}}
    render(<RecordLine widget={{...widget,config:{x:"at",y:["value"],group:"group"}}} result={result} />)
    expect(screen.getAllByRole("img")).toHaveLength(2)
    expect(screen.getByText("1 observations have no x coordinate")).toBeInTheDocument()
    expect(screen.getByText("Partial source response")).toBeInTheDocument()
  })
  it("compares timestamp records locally with ordered samples, mixed units and gaps", () => {
    const first="2026-10-27T01:00:00Z", middle="2026-10-27T02:00:00Z", last="2026-10-27T03:00:00Z"
    const result:QueryResult={records:{columns:[{key:"at",type:"timestamp"},{key:"uptime",type:"number",unit:"percent"},{key:"latency",type:"number",unit:"ms"}],rows:[[last,99,20],[first,97,10],[middle,null,15]]}}
    const actions={apply:vi.fn(),previous:vi.fn()}
    const {rerender}=render(<DashboardWindowProvider value={actions}><RecordLine widget={{...widget,config:{x:"at",y:["uptime","latency"]}}} result={result}/></DashboardWindowProvider>)
    fireEvent.click(screen.getByRole("button",{name:/compare window/i}))
    const dialog=screen.getByRole("dialog")
    expect(within(dialog).getByText("+2.00 pp")).toBeInTheDocument()
    expect(within(dialog).getByText("+10.00 ms")).toBeInTheDocument()
    expect(within(dialog).queryByRole("button",{name:/previous period|apply to dashboard/i})).not.toBeInTheDocument()
    expect(within(dialog).getByText("Zoom affects this chart only.")).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole("slider",{name:"Window start"}),{target:{value:"1"}})
    expect(within(dialog).getByText("Unavailable")).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button",{name:"Zoom chart to window"}))
    expect(screen.queryByRole("img",{name:/2026-10-27T01:00:00/})).not.toBeInTheDocument()
    expect(screen.getByRole("img",{name:/latency · 2026-10-27T03:00:00/})).toBeInTheDocument()
    expect(actions.previous).not.toHaveBeenCalled()
    expect(actions.apply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button",{name:"Reset chart zoom"}))
    expect(screen.getByRole("img",{name:/latency · 2026-10-27T01:00:00/})).toBeInTheDocument()
    // New provider data is a new snapshot and must not inherit a stale local zoom.
    fireEvent.click(screen.getByRole("button",{name:/compare window/i}))
    fireEvent.change(screen.getByRole("slider",{name:"Window start"}),{target:{value:"1"}})
    fireEvent.click(screen.getByRole("button",{name:"Zoom chart to window"}))
    rerender(<DashboardWindowProvider value={actions}><RecordLine widget={{...widget,config:{x:"at",y:["uptime","latency"]}}} result={{records:{...result.records!,rows:[...result.records!.rows]}}}/></DashboardWindowProvider>)
    expect(screen.queryByRole("button",{name:"Reset chart zoom"})).not.toBeInTheDocument()
  })
  it("does not interpret numeric or categorical coordinates as timestamps", () => {
    const {rerender}=render(<RecordLine widget={widget} result={frame([["api",12],["worker",24]])}/>)
    expect(screen.queryByRole("button",{name:/compare window/i})).not.toBeInTheDocument()
    rerender(<RecordLine widget={{...widget,config:{x:"at",y:["value"]}}} result={{records:{columns:[{key:"at",type:"number"},{key:"value",type:"number"}],rows:[[1,2],[2,3]]}}}/>)
    expect(screen.queryByRole("button",{name:/compare window/i})).not.toBeInTheDocument()
  })
  it("rejects duplicate observations instead of inventing an aggregation", () => {
    expect(()=>render(<RecordLine widget={widget} result={frame([["api",1],["api",2]])} />)).toThrow("Duplicate chart coordinates")
  })
})
