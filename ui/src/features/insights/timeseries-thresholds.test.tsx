import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { resolveTimeSeriesDomain } from "./chart-renderers";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);
const widget: Widget = { id:"burn", title:"Availability burn", type:"timeseries", providerId:"metrics", query:"burn", unit:"x", layout:{x:0,y:0,w:8,h:4} };
const result: QueryResult = { series:[{name:"burn",labels:{},points:[{timestamp:1000,value:7.9},{timestamp:2000,value:8.1}]}] };
const thresholds=[{value:2,color:"#e0a527",label:"2× threshold"}];

describe("time-series threshold guides",()=>{
  it("includes low and high thresholds in the automatic domain without clipping observations",()=>{
    const [min,max]=resolveTimeSeriesDomain(result.series!,{thresholds:[...thresholds,{value:12,color:"#df6357",label:"Critical"}]})!;
    expect(min).toBeLessThan(2);
    expect(max).toBeGreaterThan(12);
    expect(resolveTimeSeriesDomain(result.series!,{min:4,max:10,thresholds})).toEqual([4,10]);
    expect(resolveTimeSeriesDomain(result.series!,{})).toBeUndefined();
  });
  it("renders named, pointer-transparent guides and respects explicit axis bounds",()=>{
    const configured={...widget,options:{thresholds}};
    const {container,rerender}=render(<WidgetVisualization widget={configured} result={result}/>);
    const guide=screen.getByRole("img",{name:"2× threshold: 2 x"});
    expect(guide).toHaveAttribute("data-threshold-value","2");
    expect((guide as HTMLElement).style.borderColor).toBe("#e0a527");
    expect(parseFloat((guide as HTMLElement).style.top)).toBeGreaterThan(10);
    rerender(<WidgetVisualization widget={{...configured,options:{thresholds,min:4,max:10}}} result={result}/>);
    expect(container.querySelector("[data-threshold-value]")).not.toBeInTheDocument();
  });
});
