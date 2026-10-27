import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordBar, RecordLine } from "./record-charts"
import type { QueryResult, Widget } from "../schema"

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
  it("retains distinct unknown and explicitly named groups and announces omitted coordinates and source limits", () => {
    const result: QueryResult={records:{columns:[{key:"at",type:"number"},{key:"value",type:"number"},{key:"group",type:"string"}],rows:[[1,1,null],[1,2,"Unknown"],[null,3,"Unknown"]],truncated:true}}
    render(<RecordLine widget={{...widget,config:{x:"at",y:["value"],group:"group"}}} result={result} />)
    expect(screen.getAllByRole("img")).toHaveLength(2)
    expect(screen.getByText("1 observations have no x coordinate")).toBeInTheDocument()
    expect(screen.getByText("Partial source response")).toBeInTheDocument()
  })
  it("rejects duplicate observations instead of inventing an aggregation", () => {
    expect(()=>render(<RecordLine widget={widget} result={frame([["api",1],["api",2]])} />)).toThrow("Duplicate chart coordinates")
  })
})
