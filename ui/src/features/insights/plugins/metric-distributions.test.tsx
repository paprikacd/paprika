import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MetricPie, StatusHistory } from "./metric-distributions"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)
const widget: Widget={id:"distribution",title:"Service state",type:"plugin",pluginId:"pie",providerId:"metrics",query:"up",unit:"",layout:{x:0,y:0,w:6,h:4},options:{decimals:2}}
const series=(name:string,values:(number|null)[]):NonNullable<QueryResult["series"]>[number]=>({name,labels:{service:name},points:values.map((value,index)=>({timestamp:Date.UTC(2026,9,27,0,index),value}))})

describe("metric distributions",()=>{
  it("uses the latest observation for pie area, excludes missing/zero/negative values, and preserves selection precision",()=>{
    const select=vi.fn()
    const result:QueryResult={series:[series("api",[1,2.345]),series("missing",[8,null]),series("zero",[8,0]),series("negative",[8,-1])],truncated:true}
    render(<MetricPie widget={widget} result={result} onContextChange={select}/>)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole("button",{name:"api: 2.35"}),{key:" "})
    expect(select).toHaveBeenCalledWith({labels:{service:"api"},value:2.345,series:"api"})
    expect(screen.getByText("3 zero, missing or negative latest values have no slice area")).toBeInTheDocument()
    expect(screen.getByText("Partial source response")).toBeInTheDocument()
  })
  it("orders by timestamp, lets the last duplicate replace a prior value, and never revives a stale pie slice",()=>{
    const entry=series("api",[12,13])
    entry.points=[entry.points[1],entry.points[0],{...entry.points[1],value:null}]
    render(<MetricPie widget={widget} result={{series:[entry]}}/>)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.getByText(/No data/i)).toBeInTheDocument()
  })
  it("renders threshold labels and missing state, with exact selected values",()=>{
    const select=vi.fn()
    const options={...widget.options,thresholds:[{value:0,color:"#00aa00",label:"Healthy"},{value:2,color:"#cc0000",label:"Critical"}]}
    render(<StatusHistory widget={{...widget,options}} result={{series:[series("api",[0,null,2.125])]}} onContextChange={select}/>)
    const missing=screen.getByRole("button",{name:/api .*No data/})
    fireEvent.click(missing)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:null,series:"api"})
    const critical=screen.getByRole("button",{name:/api .*2.13.*Critical/})
    expect(critical).toHaveStyle({background:"#cc0000"})
    fireEvent.click(critical)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:2.125,series:"api"})
  })
  it("bounds dense history while preserving a brief incident, missing scrape, and latest endpoint",()=>{
    const values:(number|null)[]=Array.from({length:100},()=>0)
    values[23]=null;values[27]=100;values[99]=5
    render(<StatusHistory widget={{...widget,config:{maxPoints:8,maxSeries:1}}} result={{series:[series("api",values),series("worker",[1])],truncated:true}}/>)
    expect(screen.getAllByRole("button").length).toBeLessThanOrEqual(8)
    expect(screen.getByRole("button",{name:/No data/})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:/100.00/})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:/5.00/})).toBeInTheDocument()
    expect(screen.getByText("Sampled view · 1 of 2 series")).toBeInTheDocument()
    expect(screen.getByText("Partial source response")).toBeInTheDocument()
  })
})
