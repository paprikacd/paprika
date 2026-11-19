import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MetricPie, StatusHistory, statusHistoryTicks } from "./metric-distributions"
import { tooltipPinHint } from "../tooltip-content"
import type { QueryResult, Widget } from "../schema"
import { DashboardTimeZoneProvider } from "../dashboard-time-zone"
import { EmbeddedWidgetProvider } from "../widget-presentation"

afterEach(cleanup)
const widget: Widget={id:"distribution",title:"Service state",type:"plugin",pluginId:"pie",providerId:"metrics",query:"up",unit:"",layout:{x:0,y:0,w:6,h:4},options:{decimals:2}}
const series=(name:string,values:(number|null)[]):NonNullable<QueryResult["series"]>[number]=>({name,labels:{service:name},points:values.map((value,index)=>({timestamp:Date.UTC(2026,9,27,0,index),value}))})

describe("metric distributions",()=>{
  it("distinguishes sub-minute history observations in accessible names",()=>{
    const sample={name:"api",labels:{},points:[{timestamp:Date.UTC(2026,10,7,0,0,1),value:1},{timestamp:Date.UTC(2026,10,7,0,0,59),value:1}]}
    const {container}=render(<DashboardTimeZoneProvider timeZone="Australia/Melbourne"><StatusHistory widget={widget} result={{series:[sample]}} /></DashboardTimeZoneProvider>)
    expect(container.querySelector('[data-history-key="0-0"]')?.getAttribute("aria-label")).toContain("11:00:01")
    expect(container.querySelector('[data-history-key="0-1"]')?.getAttribute("aria-label")).toContain("11:00:59")
  })

  it("uses the dashboard timezone for history ticks and accessible sample names",()=>{
    const sample=series("api",[1,2,1])
    const {container}=render(<DashboardTimeZoneProvider timeZone="Australia/Melbourne"><StatusHistory widget={{...widget,config:{showTimeAxis:true}}} result={{series:[sample]}} /></DashboardTimeZoneProvider>)
    const scale=screen.getByRole("group",{name:"Status history time scale in Australia/Melbourne"})
    expect(scale.querySelector("time")).toHaveTextContent("11:00")
    expect(scale.querySelector("time")).toHaveAttribute("datetime","2026-10-27T00:00:00.000Z")
    expect(container.querySelector('[data-history-key="0-0"]')?.getAttribute("aria-label")).toMatch(/11:00/)
    expect(statusHistoryTicks(Date.UTC(2026,9,27),Date.UTC(2026,9,27,1),"UTC")[0].label).toBe("00:00")
  })

  it("keeps a pinned history sample on its own row when labels repeat, and on its own timestamp when two share one", () => {
    const rows: QueryResult["series"] = [
      { name:"a", labels:{ component:"db" }, points:[{ timestamp:Date.UTC(2026,9,27,0,0), value:1 }, { timestamp:Date.UTC(2026,9,27,0,1), value:1 }] },
      { name:"b", labels:{ component:"db" }, points:[{ timestamp:Date.UTC(2026,9,27,0,0), value:0 }, { timestamp:Date.UTC(2026,9,27,0,0), value:2 }] },
    ];
    const { container } = render(<StatusHistory widget={{ ...widget, config:{ labelField:"component" } }} result={{ series:rows }} />);
    fireEvent.click(container.querySelector('[data-history-key="1-0"]')!);
    expect(container.querySelector('[data-history-key="1-0"]')).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-history-key="0-0"]')).not.toHaveAttribute("aria-pressed", "true");
    fireEvent.click(container.querySelector('[data-history-key="1-1"]')!);
    expect(container.querySelector('[data-history-key="1-1"]')).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-history-key="1-0"]')).not.toHaveAttribute("aria-pressed", "true");
  });
  it("keeps a pinned history sample open when a refresh moves every timestamp by less than one step", () => {
    const at = (seconds: number) => Date.UTC(2026,9,27,0,0,seconds);
    const build = (offset: number, value: number) => ({ series:[{ name:"api", labels:{ service:"api" }, points:[{ timestamp:at(offset), value:0 }, { timestamp:at(offset + 60), value }] }] });
    const { container, rerender } = render(<StatusHistory widget={widget} result={build(0, 1)} />);
    fireEvent.click(container.querySelector('[data-history-key="0-1"]')!);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(<StatusHistory widget={widget} result={build(6, 3)} />);
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "3");
    rerender(<StatusHistory widget={widget} result={build(12, 4)} />);
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "4");
  });
  it("keeps a pinned history sample open when a refresh shifts an irregular row by 20 s", () => {
    // The first gap is 12 s and the rest are about 4 min, as a partial first bucket looks in the gallery. A shift of 20 s is
    // further than the shortest gap but well within half the typical gap, so the pin must follow the sample. The pinned
    // sample is the third one, whose neighbours are 204 s away, so the nearest sample after the shift is the same sample.
    const at = (seconds: number) => Date.UTC(2026,9,27,0,0,seconds);
    const build = (offset: number, value: number) => ({ series:[{ name:"api", labels:{ service:"api" }, points:[0, 12, 216, 492, 768].map((seconds, index) => ({ timestamp:at(seconds + offset), value: index === 2 ? value : 0 })) }] });
    const { container, rerender } = render(<StatusHistory widget={widget} result={build(0, 1)} />);
    fireEvent.click(container.querySelector('[data-history-key="0-2"]')!);
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "1");
    rerender(<StatusHistory widget={widget} result={build(20, 5)} />);
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "5");
    expect(container.querySelector('[data-history-key="0-2"]')).toHaveAttribute("aria-pressed","true");
  });
  it("exposes history marks through named button semantics rather than native title tooltips",()=>{
    const {container}=render(<StatusHistory widget={widget} result={{series:[series("api",[2.125])]}} />)
    const mark=screen.getByRole("button",{name:/api .*2.13/})
    expect(mark).toHaveAttribute("data-history-key","0-0")
    expect(mark).not.toHaveAttribute("title")
    expect(container.querySelector('button[title]')).toBeNull()
    fireEvent.focus(mark)
    fireEvent.click(mark)
    expect(mark).toHaveAttribute("aria-pressed","true")
    fireEvent.click(mark)
    expect(mark).not.toHaveAttribute("aria-pressed")
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })

  it("shows configured service labels and a shared UTC time scale across all lanes",()=>{
    const first=series("up{service=api}",[1,2]), second=series("up{service=worker}",[1,2])
    first.labels.service="api";second.labels.service="worker"
    second.points[1].timestamp=Date.UTC(2026,10,26)
    const {container}=render(<DashboardTimeZoneProvider timeZone="UTC"><StatusHistory widget={{...widget,config:{labelField:"service",showTimeAxis:true}}} result={{series:[first,second]}} /></DashboardTimeZoneProvider>)
    expect(container.querySelector('[data-history-series="api"]')).toBeInTheDocument()
    expect(container.querySelector('[data-history-series="worker"]')).toBeInTheDocument()
    const scale=screen.getByRole("group",{name:"Status history time scale in UTC"})
    const ticks=scale.querySelectorAll("time")
    expect(ticks).toHaveLength(5)
    expect(ticks[0]).toHaveAttribute("datetime",new Date(first.points[0].timestamp).toISOString())
    expect(ticks[4]).toHaveAttribute("datetime",new Date(second.points[1].timestamp).toISOString())
  })
  it("does not invent a time range for an isolated observation",()=>{
    expect(statusHistoryTicks(1000,1000)).toEqual([])
    render(<StatusHistory widget={{...widget,config:{showTimeAxis:true}}} result={{series:[series("api",[1])]}} />)
    expect(screen.queryByRole("group",{name:"Status history time scale in UTC"})).not.toBeInTheDocument()
  })
  it("uses the latest observation for pie area, excludes missing/zero/negative values, and preserves selection precision",()=>{
    const select=vi.fn()
    const result:QueryResult={series:[series("api",[1,2.345]),series("missing",[8,null]),series("zero",[8,0]),series("negative",[8,-1])],truncated:true}
    render(<MetricPie widget={widget} result={result} onContextChange={select}/>)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole("button",{name:"api: 2.35"}),{key:" "})
    expect(select).toHaveBeenCalledWith({labels:{service:"api"},value:2.345,series:"api",timestamp:Date.UTC(2026,9,27,0,1)})
    expect(screen.getByText("3 zero, missing or negative latest values have no slice area")).toBeInTheDocument()
    expect(screen.getByText("Provider response may be incomplete")).toBeInTheDocument()
  })
  it("inspects the exact pie observation without selecting on hover and retains the pinned context",()=>{
    const select=vi.fn(), current:QueryResult={series:[series("api",[1,2.5]),series("worker",[1,7.5])]}
    const {container,rerender}=render(<MetricPie widget={widget} result={current} onContextChange={select}/>)
    const api=screen.getByRole("button",{name:"api: 2.50"}), worker=screen.getByRole("button",{name:"worker: 7.50"})
    fireEvent.pointerEnter(api,{pointerType:"mouse"})
    const tip=screen.getByRole("tooltip")
    expect(container).not.toContainElement(tip)
    expect(tip.querySelector('[data-metric-value="2.5"]')).toHaveTextContent("2.50")
    expect(tip.querySelector("time")).toHaveAttribute("datetime",new Date(Date.UTC(2026,9,27,0,1)).toISOString())
    expect(tip.querySelectorAll("time")).toHaveLength(1)
    expect(tip.querySelector("time")!.compareDocumentPosition(tip.querySelector('[data-metric-value="2.5"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tip.querySelector("time")!.compareDocumentPosition(tip.querySelector("dl")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tip).toHaveTextContent("Share of positive observations: 25.00%")
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(api)
    expect(select).toHaveBeenCalledExactlyOnceWith({labels:{service:"api"},value:2.5,series:"api",timestamp:Date.UTC(2026,9,27,0,1)})
    expect(api).toHaveAttribute("aria-pressed","true")
    fireEvent.pointerEnter(worker,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="2.5"]')).toBeInTheDocument()
    fireEvent.keyDown(api,{key:"Escape"})
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.focus(worker)
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="7.5"]')).toBeInTheDocument()
    expect(select).toHaveBeenCalledTimes(1)
    rerender(<MetricPie widget={widget} result={{series:[series("new",[3])]}} onContextChange={select}/>)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("tells the viewer how a pinned pie slice closes, and how an open one is pinned",()=>{
    render(<MetricPie widget={widget} result={{series:[series("api",[1,2.5]),series("worker",[1,7.5])]}} onContextChange={vi.fn()}/>)
    const api=screen.getByRole("button",{name:"api: 2.50"})
    fireEvent.pointerEnter(api,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toHaveTextContent(tooltipPinHint(false))
    fireEvent.click(api)
    expect(screen.getByRole("tooltip")).toHaveTextContent(tooltipPinHint(true))
  })
  it("preserves relative pie shares when the sum of finite observations overflows",()=>{
    const result:QueryResult={series:[series("large-a",[1e308]),series("large-b",[1e308]),series("smaller",[5e307])]}
    const {container}=render(<MetricPie widget={widget} result={result}/> )
    const paths=[...container.querySelectorAll<SVGPathElement>('[data-pie-index] path')].map(path=>path.getAttribute("d"))
    expect(paths).toHaveLength(3)
    expect(paths.every(path=>path && !/NaN|Infinity/.test(path))).toBe(true)
    expect(new Set(paths).size).toBe(3)
    fireEvent.pointerEnter(container.querySelector('[data-pie-index="0"]')!,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toHaveTextContent("Share of positive observations: 40.00%")
  })
  it("preserves proportions for positive subnormal observations",()=>{
    const result:QueryResult={series:[series("small",[Number.MIN_VALUE]),series("larger",[Number.MIN_VALUE*2])]}
    const {container}=render(<MetricPie widget={widget} result={result}/> )
    fireEvent.pointerEnter(container.querySelector('[data-pie-index="0"]')!,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toHaveTextContent("Share of positive observations: 33.33%")
  })
  it("respects disabled tooltips and keeps explicit selection available",()=>{
    const select=vi.fn()
    render(<MetricPie widget={{...widget,options:{...widget.options,showTooltip:false}}} result={{series:[series("api",[4])]}} onContextChange={select}/>)
    const slice=screen.getByRole("button",{name:"api: 4"})
    fireEvent.pointerEnter(slice,{pointerType:"mouse"})
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.keyDown(slice,{key:"Enter"})
    expect(select).toHaveBeenCalledExactlyOnceWith({labels:{service:"api"},value:4,series:"api",timestamp:Date.UTC(2026,9,27)})
  })
  it("uses collision-safe compact legend labels while preserving full identity in selection and inspection",()=>{
    const select=vi.fn(), at=Date.UTC(2026,9,27)
    const entries:NonNullable<QueryResult["series"]>=[
      {name:'{cluster="omega", node="node-01"}',labels:{cluster:"omega",node:"node-01"},points:[{timestamp:at,value:1}]},
      {name:'{cluster="omega", node="node-02"}',labels:{cluster:"omega",node:"node-02"},points:[{timestamp:at,value:2}]},
      {name:'{cluster="delta", node="node-01"}',labels:{cluster:"delta",node:"node-01"},points:[{timestamp:at,value:3}]},
      {name:"Authored alias",labels:{cluster:"delta",node:"node-03"},points:[{timestamp:at,value:4}]},
    ]
    render(<MetricPie widget={widget} result={{series:entries}} onContextChange={select}/>)
    const legend=screen.getByRole("region",{name:"Legend for Service state"})
    const names=[...legend.querySelectorAll(":scope > span")]
    expect(names.map(item=>item.textContent)).toEqual(["node=node-01 · cluster=omega 1","node=node-02 · cluster=omega 2","node=node-01 · cluster=delta 3","Authored alias 4"])
    expect(new Set(names.map(item=>item.textContent)).size).toBe(4)
    expect(names[0]).toHaveAttribute("title",entries[0].name)
    expect(names[0]).toHaveAttribute("aria-label",`${entries[0].name}: 1`)
    expect(names[0]).toHaveAttribute("role","group")
    const slice=screen.getByRole("button",{name:`${entries[0].name}: 1`})
    fireEvent.pointerEnter(slice,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toHaveTextContent(entries[0].name)
    fireEvent.click(slice)
    expect(select).toHaveBeenCalledExactlyOnceWith({labels:entries[0].labels,series:entries[0].name,value:1,timestamp:at})
  })
  it("offers keyboard inspection without a selection binding and suppresses nested tooltip interaction",()=>{
    const result:QueryResult={series:[series("api",[4])]}
    const {rerender}=render(<MetricPie widget={widget} result={result}/>)
    const slice=screen.getByRole("button",{name:"api: 4"})
    fireEvent.focus(slice)
    expect(screen.getByRole("tooltip")).toHaveTextContent("api")
    fireEvent.keyDown(slice,{key:"Enter"})
    expect(slice).toHaveAttribute("aria-pressed","true")
    rerender(<EmbeddedWidgetProvider><MetricPie widget={widget} result={result}/></EmbeddedWidgetProvider>)
    expect(screen.queryByRole("button",{name:"api: 4"})).not.toBeInTheDocument()
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("orders by timestamp, lets the last duplicate replace a prior value, and never revives a stale pie slice",()=>{
    const entry=series("api",[12,13])
    entry.points=[entry.points[1],entry.points[0],{...entry.points[1],value:null}]
    render(<MetricPie widget={widget} result={{series:[entry]}}/>)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.getByText(/No data/i)).toBeInTheDocument()
  })
  it("strokes warning and critical history marks, adds glyph chips to the legend, and leaves hex-only bands unmarked",()=>{
    const options={...widget.options,thresholds:[{value:0,status:"ok" as const,label:"Healthy"},{value:1,status:"warning" as const,label:"Degraded"},{value:2,status:"critical" as const,label:"Critical"}]}
    const {container,unmount}=render(<StatusHistory widget={{...widget,options}} result={{series:[series("api",[0,1.5,2.125])]}}/>)
    const marks=[...container.querySelectorAll<HTMLElement>("[data-history-value]")]
    // Marks carry no frame of their own; each contiguous warning or critical run is framed once, so a single sample is one framed run.
    expect(marks.map(mark=>mark.getAttribute("data-status-stroke"))).toEqual([null,null,null])
    expect([...container.querySelectorAll<HTMLElement>("[data-status-run]")].map(run=>run.getAttribute("data-status-run"))).toEqual(["warning","critical"])
    expect(container.querySelector('[role="group"][aria-label="Status history legend"]')!.querySelectorAll("[data-status]")).toHaveLength(3)
    unmount()
    const hex=render(<StatusHistory widget={{...widget,options:{...widget.options,thresholds:[{value:0,color:"#00aa00",label:"Healthy"},{value:2,color:"#cc0000",label:"Critical"}]}}} result={{series:[series("api",[0,2.125])]}}/>)
    expect(hex.container.querySelector("[data-status-stroke]")).toBeNull()
    expect(hex.container.querySelector("[data-status]")).toBeNull()
  })
  it("renders threshold labels and missing state, with exact selected values",()=>{
    const select=vi.fn()
    const options={...widget.options,thresholds:[{value:0,color:"#00aa00",label:"Healthy"},{value:2,color:"#cc0000",label:"Critical"}]}
    render(<StatusHistory widget={{...widget,options}} result={{series:[series("api",[0,null,2.125])]}} onContextChange={select}/>)
    const missing=screen.getByRole("button",{name:/api .*No data/})
    fireEvent.click(missing)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:null,series:"api",timestamp:Date.UTC(2026,9,27,0,1)})
    const critical=screen.getByRole("button",{name:/api .*2.13.*Critical/})
    expect(critical).toHaveStyle({background:"#cc0000"})
    fireEvent.click(critical)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:2.125,series:"api",timestamp:Date.UTC(2026,9,27,0,2)})
  })
  it("bounds dense history while preserving a brief incident, missing scrape, and latest endpoint",()=>{
    const values:(number|null)[]=Array.from({length:100},()=>0)
    values[23]=null;values[27]=100;values[99]=5
    render(<StatusHistory widget={{...widget,config:{maxPoints:8,maxSeries:1}}} result={{series:[series("api",values),series("worker",[1])],truncated:true}}/>)
    expect(screen.getAllByRole("button").length).toBeLessThanOrEqual(8)
    expect(screen.getByRole("button",{name:/No data/})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:/100/})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:/5/})).toBeInTheDocument()
    expect(screen.getByText("Sampled view · 1 of 2 series")).toBeInTheDocument()
    expect(screen.getByText("Provider response may be incomplete")).toBeInTheDocument()
  })
  it("names a row cap in the neutral limit wording, not as a partial source, in status history",()=>{
    render(<StatusHistory widget={widget} result={{series:[series("api",[1,2])],truncated:true,truncation:{reason:"row_limit",limit:100,unit:"series"}}}/>)
    expect(screen.getByText("Source row limit reached · narrow the query to see others")).toBeInTheDocument()
    expect(screen.queryByText("Partial source response")).toBeNull()
  })
  it("keeps all six compact lanes individually labeled and selects the final lane's exact observation",()=>{
    const select=vi.fn()
    const names=["Backend-ops-01","Backend-ops-02","Backend-ops-03","Backend-ops-04","Frontend-web-01","Frontend-web-02"]
    const {container}=render(<StatusHistory widget={widget} result={{series:names.map(name=>series(name,[1,2.125,null]))}} onContextChange={select}/>)
    const lanes=container.querySelectorAll("[data-history-series]")
    expect(lanes).toHaveLength(6)
    for(const [index,lane] of [...lanes].entries()) {
      expect(lane).toHaveAttribute("data-history-series",names[index])
      expect(lane.querySelector("strong")).toHaveAttribute("title",names[index])
      expect(lane.querySelectorAll("button")).toHaveLength(3)
    }
    fireEvent.click(screen.getByRole("button",{name:/Frontend-web-02 .*2.13/}))
    expect(select).toHaveBeenLastCalledWith({labels:{service:"Frontend-web-02"},value:2.125,series:"Frontend-web-02",timestamp:Date.UTC(2026,9,27,0,1)})
    fireEvent.click(screen.getByRole("button",{name:/Frontend-web-02 .*No data/}))
    expect(select).toHaveBeenLastCalledWith({labels:{service:"Frontend-web-02"},value:null,series:"Frontend-web-02",timestamp:Date.UTC(2026,9,27,0,2)})
  })
  it("uses a single tab stop for the history and navigates exact samples across rows and time",()=>{
    const first=series("Backend-ops-01",[0,1,2]), second=series("Backend-ops-02",[4,5])
    second.points=[first.points[0],first.points[2]].map((point,index)=>({...point,value:index+4}))
    const {container}=render(<StatusHistory widget={widget} result={{series:[first,second]}} />)
    const cells=[...container.querySelectorAll<HTMLButtonElement>('[data-history-key]')]
    expect(cells.filter(cell=>cell.tabIndex===0)).toHaveLength(1)
    expect(cells.filter(cell=>cell.tabIndex===-1)).toHaveLength(4)
    fireEvent.focus(cells[0])
    fireEvent.keyDown(cells[0],{key:"ArrowRight"})
    expect(cells[1]).toHaveFocus()
    fireEvent.keyDown(cells[1],{key:"ArrowDown"})
    expect(cells[3]).toHaveFocus() // nearest timestamp in the next row
    fireEvent.keyDown(cells[3],{key:"ArrowRight"})
    expect(cells[4]).toHaveFocus()
    expect(cells.filter(cell=>cell.tabIndex===0)).toEqual([cells[4]])
    fireEvent.click(cells[4])
    expect(cells[4]).toHaveAttribute("aria-pressed","true")
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="5"]')).toBeInTheDocument()
  })
  it("closes a hovered history sample after the pointer leaves, even while another sample keeps focus",()=>{
    vi.useFakeTimers()
    try {
      const {container}=render(<StatusHistory widget={widget} result={{series:[series("api",[0,1,2])]}} />)
      const cells=[...container.querySelectorAll<HTMLButtonElement>('[data-history-key]')]
      act(()=>cells[0].focus())
      fireEvent.pointerEnter(cells[2],{pointerType:"mouse"})
      expect(screen.getByRole("tooltip")).toBeInTheDocument()
      fireEvent.pointerLeave(cells[2])
      act(()=>{ vi.advanceTimersByTime(200) })
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
      expect(cells[0]).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })
  it("keeps a pinned history sample open with its refreshed value, and releases it when the sample leaves",()=>{
    const {container,rerender}=render(<StatusHistory widget={widget} result={{series:[series("api",[1,2,3])]}} />)
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-history-key="0-1"]')!)
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="2"]')).toBeInTheDocument()
    // The refresh changes the value of the same sample: the pin stays and shows the new reading.
    rerender(<StatusHistory widget={widget} result={{series:[series("api",[1,7,3])]}} />)
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="7"]')).toBeInTheDocument()
    expect(container.querySelector('[data-history-key="0-1"]')).toHaveAttribute("aria-pressed","true")
    // A refresh without that sample's timestamp closes the pin.
    rerender(<StatusHistory widget={widget} result={{series:[series("api",[1])]}} />)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("heads a history sample with its series, not the widget title",()=>{
    const {container}=render(<StatusHistory widget={widget} result={{series:[series("api",[1])]}} />)
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-history-key]')!)
    expect(within(screen.getByRole("tooltip")).getByText("api",{selector:"strong"})).toBeInTheDocument()
  })
  it("gives each narrow sample its own pointer slice, so hovering a slice opens its own sample",()=>{
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){ return this.matches?.("[data-history-track]") ? {x:0,y:0,left:0,top:0,right:300,bottom:20,width:300,height:20,toJSON(){}} as DOMRect : {x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0,toJSON(){}} as DOMRect })
    const entries=series("api",Array.from({length:85},(_,index)=>index%3===0?1:2))
    const {container}=render(<StatusHistory widget={widget} result={{series:[entries]}}/>)
    const samples=container.querySelectorAll("[data-history-key]").length
    const slices=[...container.querySelectorAll<HTMLElement>("[data-history-hit]")]
    expect(slices).toHaveLength(samples)
    const target=slices[Math.floor(samples/2)], key=target.getAttribute("data-history-hit")!
    fireEvent.pointerEnter(target,{pointerType:"mouse"})
    expect(container.querySelector(`[data-history-key="${key}"]`)).toHaveAttribute("aria-pressed")
    const neighbour=key.replace(/-(\d+)$/,(_,n)=>`-${Number(n)+1}`)
    expect(container.querySelector(`[data-history-key="${neighbour}"]`)).not.toHaveAttribute("aria-pressed")
    vi.restoreAllMocks()
  })
  it("keeps a pinned sample pinned under a pointer on its slice, and a second click on the slice unpins it",()=>{
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){ return this.matches?.("[data-history-track]") ? {x:0,y:0,left:0,top:0,right:300,bottom:20,width:300,height:20,toJSON(){}} as DOMRect : {x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0,toJSON(){}} as DOMRect })
    try {
      const entries=series("api",Array.from({length:85},(_,index)=>index%3===0?1:2))
      const {container}=render(<StatusHistory widget={widget} result={{series:[entries]}}/>)
      const slices=[...container.querySelectorAll<HTMLElement>("[data-history-hit]")]
      const slice=slices[Math.floor(slices.length/2)], key=slice.getAttribute("data-history-hit")!
      const sample=container.querySelector<HTMLButtonElement>(`[data-history-key="${key}"]`)!
      // The slice belongs to its sample: a pointer on it is a pointer on the sample, not an outside click.
      expect(sample).toContainElement(slice)
      fireEvent.pointerDown(slice,{pointerType:"mouse"})
      fireEvent.click(slice)
      expect(sample).toHaveAttribute("aria-pressed","true")
      fireEvent.pointerDown(slice,{pointerType:"mouse"})
      expect(sample).toHaveAttribute("aria-pressed","true")
      fireEvent.click(slice)
      expect(sample).not.toHaveAttribute("aria-pressed","true")
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    } finally {
      vi.restoreAllMocks()
    }
  })
  it("keeps endpoint hit areas inside the lane while preserving exact selected samples",()=>{
    const select=vi.fn(), entries=series("api",[1,2,3])
    const {container}=render(<StatusHistory widget={widget} result={{series:[entries]}} onContextChange={select}/>)
    const cells=[...container.querySelectorAll<HTMLButtonElement>('[data-history-key]')]
    const [first,last]=[cells[0],cells.at(-1)!]
    expect(first).toHaveAttribute("data-history-edge","start")
    expect(last).toHaveAttribute("data-history-edge","end")
    const firstLeft=parseFloat(first.style.left),firstWidth=parseFloat(first.style.width)
    const lastLeft=parseFloat(last.style.left),lastWidth=parseFloat(last.style.width)
    expect(firstLeft).toBeCloseTo(0)
    expect(lastLeft).toBeCloseTo(100)
    expect(firstWidth).toBeGreaterThan(0)
    expect(lastWidth).toBeGreaterThan(0)
    fireEvent.click(first)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:1,series:"api",timestamp:entries.points[0].timestamp})
    fireEvent.click(last)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:3,series:"api",timestamp:entries.points[2].timestamp})
  })
  it("portals the hovered and pinned sample with its exact observation, labels, status and timestamp",()=>{
    const select=vi.fn()
    const options={...widget.options,thresholds:[{value:0,color:"#00aa00",label:"Healthy"},{value:2,color:"#cc0000",label:"Critical"}]}
    const current:QueryResult={series:[series("api",[0,null,2.125])]}
    const {container,rerender}=render(<StatusHistory widget={{...widget,options}} result={current} onContextChange={select}/>)
    const critical=screen.getByRole("button",{name:/api .*2.13.*Critical/})
    fireEvent.pointerEnter(critical,{pointerType:"mouse"})
    expect(select).not.toHaveBeenCalled()
    const tooltip=screen.getByRole("tooltip")
    expect(container).not.toContainElement(tooltip)
    expect(tooltip.querySelector('[data-metric-value="2.125"]')).toHaveTextContent("2.13")
    expect(tooltip).toHaveTextContent("Critical")
    expect(tooltip).toHaveTextContent("service:")
    expect(tooltip.querySelector("time")).toHaveAttribute("datetime",new Date(Date.UTC(2026,9,27,0,2)).toISOString())
    fireEvent.click(critical)
    expect(select).toHaveBeenLastCalledWith({labels:{service:"api"},value:2.125,series:"api",timestamp:Date.UTC(2026,9,27,0,2)})
    expect(critical).toHaveAttribute("aria-pressed","true")
    fireEvent.pointerLeave(critical)
    expect(screen.getByRole("tooltip")).toBeInTheDocument()
    fireEvent.keyDown(critical,{key:"Escape"})
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.pointerEnter(critical,{pointerType:"mouse"})
    rerender(<StatusHistory widget={{...widget,options}} result={{series:[series("api",[9])]}} onContextChange={select}/>)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("keeps hover previews pointer-transparent when a widget occupies the whole viewport",()=>{
    const width=window.innerWidth,height=window.innerHeight
    vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>({x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON(){}}))
    render(<div data-widget-id="history"><StatusHistory widget={widget} result={{series:[series("api",[2.125])]}} /></div>)
    const cell=screen.getByRole("button",{name:/api .*2.13/})
    fireEvent.pointerEnter(cell,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-tooltip-overlap","true")
    expect(screen.getByRole("tooltip")).toHaveStyle({pointerEvents:"none"})
    fireEvent.click(cell)
    expect(screen.getByRole("tooltip")).not.toHaveStyle({pointerEvents:"none"})
  })
  it("dismisses a hover preview when focus moves elsewhere but retains a pinned observation",()=>{
    render(<><StatusHistory widget={widget} result={{series:[series("api",[2.125])]}} /><button>Another chart</button></>)
    const cell=screen.getByRole("button",{name:/api .*2.13/})
    const outside=screen.getByRole("button",{name:"Another chart"})
    fireEvent.pointerEnter(cell,{pointerType:"mouse"})
    expect(screen.getByRole("tooltip")).toBeInTheDocument()
    fireEvent.focusIn(outside)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.pointerEnter(cell,{pointerType:"mouse"})
    fireEvent.click(cell)
    fireEvent.focusIn(outside)
    expect(screen.getByRole("tooltip")).toBeInTheDocument()
  })
  it("labels unknown values separately and lays equal timestamps at the same horizontal position",()=>{
    const first=series("api",[0,1,2,3]), second=series("worker",[1,2])
    second.points=[first.points[1],first.points[3]]
    const {container}=render(<StatusHistory widget={widget} result={{series:[first,second]}} />)
    const rows=container.querySelectorAll('[data-history-series]')
    const a=rows[0].querySelectorAll<HTMLButtonElement>('button'),b=rows[1].querySelectorAll<HTMLButtonElement>('button')
    expect(b[0].style.left).toBe(a[1].style.left)
    // Endpoint marks are clipped to the lane; their visible right edges still
    // align at the shared timestamp even if their source cadences differ.
    expect(parseFloat(b[1].style.left)).toBeCloseTo(100)
    expect(parseFloat(a[3].style.left)).toBeCloseTo(100)
    expect(screen.getByRole("group",{name:"Status history legend"})).toHaveTextContent("Unknown")
  })
  it("renders continuous stable sampled bands and marks hidden changes or missing observations distinctly",()=>{
    const values:(number|null)[]=Array.from({length:100},(_,index)=>index===24 ? null : index===25 ? 3 : 0)
    const options={...widget.options,thresholds:[{value:0,color:"#00aa00",label:"Healthy"},{value:2,color:"#cc0000",label:"Critical"}]}
    const {container}=render(<StatusHistory widget={{...widget,options,config:{maxPoints:8}}} result={{series:[series("api",values)]}} />)
    expect(container.querySelectorAll('[data-history-band="stable"]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-history-band="mixed"]').length).toBeGreaterThan(0)
    expect(screen.getByRole("group",{name:"Status history legend"})).toHaveTextContent("Mixed / uncertain")
    expect(screen.getAllByRole("img",{name:/Changes, missing samples or duplicate timestamps/}).length).toBeGreaterThan(0)
    expect(screen.getByRole("button",{name:/api .*No data/})).toBeInTheDocument()
    expect(screen.getByRole("button",{name:/api .*3.*Critical/})).toBeInTheDocument()
  })
})
