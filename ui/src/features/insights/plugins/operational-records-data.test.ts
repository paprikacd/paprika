import { describe, expect, it } from "vitest"
import type { RecordFrame } from "../schema"
import { buildConnectionMap, buildIncidentCalendar, buildPipelineTopology, connectionMapConfig, incidentCalendarConfig, pipelineTopologyConfig, utcDay } from "./operational-records-data"

const mapFrame = (rows: RecordFrame["rows"]): RecordFrame => ({columns:[{key:"label",type:"string"},{key:"latitude",type:"number"},{key:"longitude",type:"number"},{key:"value",type:"number"},{key:"service",type:"string"}],rows})
const edgeFrame = (rows: RecordFrame["rows"]): RecordFrame => ({columns:[{key:"source",type:"string"},{key:"target",type:"string"},{key:"value",type:"number"},{key:"service",type:"string"}],rows})
const dateFrame = (rows: RecordFrame["rows"]): RecordFrame => ({columns:[{key:"date",type:"string"},{key:"value",type:"number"},{key:"service",type:"string"}],rows})

describe("connection map data",()=>{
  it("plots exact supplied coordinates and retains negative, zero and missing measurements",()=>{
    const data=buildConnectionMap(mapFrame([["West",-90,-180,-12.347,"api"],["Center",0,0,0,"api"],["East",90,180,null,"api"]]),connectionMapConfig.parse({value:"value"}))
    expect(data.locations.map(point=>[point.x,point.y,point.value])).toEqual([[0,1,-12.347],[.5,.5,0],[1,0,null]])
    expect(data.locations[0].context).toEqual({series:"West",value:-12.347,labels:{label:"West",latitude:"-90",longitude:"-180",value:"-12.347",service:"api"}})
  })
  it("does not geolocate labels or clamp invalid coordinates into a real location",()=>{
    const data=buildConnectionMap(mapFrame([["London",null,null,1,"api"],["Bad",91,200,2,"api"],["Sydney",-33.86,151.2,3,"api"],["Melbourne",-37.81,144.96,4,"api"]]),connectionMapConfig.parse({maxPoints:1}))
    expect(data.invalid).toBe(2);expect(data.omitted).toBe(1);expect(data.locations.map(point=>point.label)).toEqual(["Sydney"])
  })
  it("requires explicit typed coordinate columns and rejects unsafe configuration",()=>{
    expect(()=>buildConnectionMap({columns:[{key:"latitude",type:"string"},{key:"longitude",type:"number"},{key:"label",type:"string"}],rows:[["12",30,"Bad"]]},connectionMapConfig.parse({}))).toThrow("numeric column")
    expect(()=>connectionMapConfig.parse({maxPoints:501})).toThrow()
    expect(()=>connectionMapConfig.parse({url:"https://example.com"})).toThrow()
  })
})

describe("pipeline topology data",()=>{
  it("combines duplicate directed connections without confusing reverse edges",()=>{
    const data=buildPipelineTopology(edgeFrame([["source","collector",2.123,"api"],["source","collector",3.456,"api"],["collector","source",1,"api"]]),pipelineTopologyConfig.parse({value:"value"}))
    expect(data.edges).toHaveLength(2);expect(data.merged).toBe(1);expect(data.cycles).toBe(1)
    const forward=data.edges.find(edge=>edge.source==="source")!
    expect(forward.value).toBeCloseTo(5.579);expect(forward.observations).toBe(2)
    expect(forward.context).toEqual({series:"source → collector",value:forward.value,labels:{source:"source",target:"collector",service:"api"}})
    expect(data.nodes.every(node=>node.cyclic)).toBe(true)
  })
  it("keeps unknown aggregation unknown and preserves zero",()=>{
    const data=buildPipelineTopology(edgeFrame([["a","b",0,"api"],["b","c",4,"api"],["b","c",null,"api"]]),pipelineTopologyConfig.parse({value:"value"}))
    expect(data.edges[0].value).toBe(0);expect(data.edges[1].value).toBeNull()
    expect(data.nodes.find(node=>node.id==="c")!.x).toBeGreaterThan(data.nodes.find(node=>node.id==="a")!.x)
  })
  it("bounds the diagram, reports dropped observations and handles self loops",()=>{
    const data=buildPipelineTopology(edgeFrame([["a","a",1,"api"],["a","b",2,"api"],["b","c",3,"api"],["",null,4,"api"]]),pipelineTopologyConfig.parse({maxNodes:2,maxEdges:1}))
    expect(data.edges).toHaveLength(1);expect(data.cycles).toBe(1);expect(data.invalid).toBe(1)
    expect(data.omittedEdges).toBe(2);expect(data.omittedNodes).toBe(2)
    expect(data.nodes[0].x).toBeGreaterThanOrEqual(0);expect(data.width).toBeGreaterThan(data.nodes[0].x+128)
  })
  it("never emits arbitrary row labels as though they described an aggregate",()=>{
    const data=buildPipelineTopology(edgeFrame([["a","b",1,"api"],["a","b",2,"worker"]]),pipelineTopologyConfig.parse({value:"value"}))
    expect(data.edges[0].context.labels).toEqual({source:"a",target:"b"})
    expect(()=>pipelineTopologyConfig.parse({maxNodes:65})).toThrow()
  })
})

describe("incident calendar data",()=>{
  it("uses UTC dates and rejects ambiguous or impossible dates",()=>{
    expect(utcDay("2026-10-29T01:30:00+11:00")).toBe("2026-10-28")
    expect(utcDay("2026-02-30")).toBeUndefined();expect(utcDay("29/10/2026")).toBeUndefined()
    expect(utcDay("2026-10-29T12:00:00")).toBeUndefined();expect(utcDay(Infinity)).toBeUndefined()
    expect(utcDay(Date.UTC(2026,9,29))).toBe("2026-10-29")
  })
  it("aggregates exact records while separating missing days from recorded zero",()=>{
    const data=buildIncidentCalendar(dateFrame([["2026-10-01",0,"api"],["2026-10-03",1.112,"api"],["2026-10-03",2.223,"api"],["2026-10-04",null,"api"]]),incidentCalendarConfig.parse({value:"value",aggregation:"sum",months:1}))
    const [zero,absent,sum,unknown]=data.months[0].days
    expect(zero.value).toBe(0);expect(zero.observations).toBe(1)
    expect(absent.value).toBeNull();expect(absent.observations).toBe(0)
    expect(sum.value).toBeCloseTo(3.335);expect(sum.context.labels).toEqual({date:"2026-10-03",service:"api",aggregation:"sum",observations:"2"})
    expect(unknown.value).toBeNull();expect(unknown.observations).toBe(1)
    expect(data.months[0].offset).toBe(3);expect(data.months[0].days).toHaveLength(31)
  })
  it("counts records without interpreting null values as missing events",()=>{
    const data=buildIncidentCalendar(dateFrame([["2026-02-04",null,"api"],["2026-02-04",2,"api"]]),incidentCalendarConfig.parse({months:1}))
    expect(data.months[0].days[3].value).toBe(2);expect(data.months[0].days).toHaveLength(28)
    expect(data.valueUnit).toBe("observations")
  })
  it("bounds months and reports observations excluded by explicit date window",()=>{
    const data=buildIncidentCalendar(dateFrame([["2026-01-01",1,"api"],["2026-10-10",2,"api"],["bad date",3,"api"]]),incidentCalendarConfig.parse({months:2,endDate:"2026-10-31",value:"value",aggregation:"max"}))
    expect(data.months.map(month=>month.key)).toEqual(["2026-09","2026-10"]);expect(data.outside).toBe(1);expect(data.invalid).toBe(1)
    expect(data.months[1].days[9].value).toBe(2)
    expect(()=>incidentCalendarConfig.parse({aggregation:"sum"})).toThrow()
    expect(()=>incidentCalendarConfig.parse({months:7})).toThrow()
    expect(()=>incidentCalendarConfig.parse({endDate:"2026-02-30"})).toThrow()
  })
})
