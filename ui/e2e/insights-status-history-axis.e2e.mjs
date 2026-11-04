// Exercise the shared time scale and label projection through actual provider responses.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const output = join(root,"artifacts/insights/status-history-axis")
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true}), errors=[]
try {
  for (const width of [1512,390]) for (const theme of ["Light","Dark"]) {
    const context=await browser.newContext({viewport:{width,height:width===390?844:1100},hasTouch:width===390,reducedMotion:"reduce"})
    const page=await context.newPage(), fixture=await installRichChartFixtureAPI(page,base)
    page.on("pageerror",error=>errors.push(error.message))
    const dashboard=fixture.documents.get("example-artboard-service-pulse"), widget=dashboard.widgets.find(widget=>widget.id==="states")
    fixture.savedQueries.set("test-incidents",{schemaVersion:1,id:"test-incidents",name:"Recorded incidents",providerId:"example-records",kind:"records",query:'{"fixture":"test-incident"}'})
    const chart=dashboard.widgets.find(widget=>widget.id==="request-history")
    chart.annotationSource={queryRef:{id:"test-incidents"},timestampColumn:"started_at",endColumn:"ended_at",labelColumn:"label",severityColumn:"severity"}
    chart.options={...chart.options,thresholds:[{value:2,color:"#e0a527",label:"2× threshold"}]}
    widget.title="Service SLO state timeline"; widget.pluginId="status-history"; widget.config={maxSeries:8,maxPoints:60,labelField:"service",showTimeAxis:true,segmented:true}
    widget.options={thresholds:[{value:0,color:"#21c890",label:"Healthy"},{value:1,color:"#efb530",label:"At risk"},{value:2,color:"#e45757",label:"Breaching"}],showLegend:true,showTooltip:true}
    await page.route("**/api/insights/query",async route=>{
      const request=route.request().postDataJSON()
      if(request.query === '{"fixture":"test-incident"}') {
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:{columns:[{key:"started_at",type:"timestamp"},{key:"ended_at",type:"timestamp"},{key:"label",type:"string"},{key:"severity",type:"string"}],rows:[[new Date((request.end-1800)*1000).toISOString(),new Date((request.end-1200)*1000).toISOString(),"Database incident","critical"]]}})})
      }
      if(request.query.startsWith("paprika_example_ab_service_pulse_requests{")) {
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({series:[{name:"burn",labels:{service:"uptime-api"},points:Array.from({length:61},(_,index)=>({timestamp:(request.start+(request.end-request.start)*index/60)*1000,value:7.9+0.2*index/60}))}]})})
      }
      if(!request.query.startsWith("paprika_example_ab_service_pulse_states{")) return route.fallback()
      const end=request.end*1000, start=end-30*24*60*60*1000
      const series=["uptime-api","payment-api","auth-api","catalog-api","worker"].map((name,row)=>({name:`up{service="${name}"}`,labels:{service:name},points:Array.from({length:30},(_,i)=>({timestamp:start+i*(end-start)/29,value:i===10&&row===1?2:i===16&&row===2?1:0}))}))
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({series})})
    })
    await page.goto(`${base}/dashboard/insights/?dashboard=example-artboard-service-pulse`,{waitUntil:"networkidle"})
    await page.getByRole("heading",{name:"Service Pulse · Test fixture",exact:true}).waitFor()
    await selectGammaOption(page,page.getByRole("combobox",{name:"Dashboard appearance",exact:true}),theme)
    const graph=page.locator('[data-widget-id="request-history"]'), band=graph.locator('[data-annotation-interval="true"]')
    await graph.scrollIntoViewIfNeeded()
    const threshold=graph.locator('[data-threshold-value="2"]'); await threshold.waitFor({state:"attached"})
    const bounds=await threshold.evaluate(node=>{const line=node.getBoundingClientRect(), plot=node.parentElement.getBoundingClientRect();return {top:line.top,bottom:line.bottom,plotTop:plot.top,plotBottom:plot.bottom,pointer:getComputedStyle(node).pointerEvents}})
    assert.equal(bounds.pointer,"none")
    assert.ok(bounds.top>bounds.plotTop && bounds.top<bounds.plotBottom,"Autoscale must include the 2× guide even with observations around 8×")
    await band.waitFor({state:"attached"})
    assert.equal(await band.evaluate(node=>getComputedStyle(node).pointerEvents),"none")
    assert.ok((await band.boundingBox()).width>0,"An interval must shade its actual duration")
    await graph.getByRole("group",{name:"Chart events"}).locator("summary").click()
    assert.equal(await graph.getByRole("group",{name:"Chart events"}).locator("time").count(),2)
    const host=page.locator('[data-widget-id="states"]'); await host.scrollIntoViewIfNeeded()
    const rows=host.locator("[data-history-series]"); await rows.nth(4).waitFor()
    assert.equal(await rows.count(),5)
    assert.deepEqual(await rows.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-history-series"))),["uptime-api","payment-api","auth-api","catalog-api","worker"])
    assert.notEqual(await rows.first().getByRole("button").first().evaluate(node=>getComputedStyle(node).boxShadow),"none")
    const axis=host.getByRole("group",{name:"Status history time scale in UTC"})
    assert.equal(await axis.locator("time").count(),5)
    const times=await axis.locator("time").evaluateAll(nodes=>nodes.map(node=>Date.parse(node.dateTime)))
    assert.equal(times[4]-times[0],30*24*60*60*1000)
    const incident=rows.nth(1).getByRole("button",{name:/Breaching/}); await incident.focus()
    await page.keyboard.press("Enter")
    const tooltip=page.getByRole("tooltip"); await tooltip.waitFor()
    assert.match(await tooltip.innerText(),/Breaching/)
    assert.equal(await tooltip.locator("[data-metric-value]").getAttribute("data-metric-value"),"2")
    await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"})
    assert.deepEqual(fixture.failures,[])
    await page.screenshot({path:join(output,`${theme.toLowerCase()}-${width}.png`),animations:"disabled"})
    await context.close(); console.log(`PASS ${theme} ${width}px status history`)
  }
  assert.deepEqual(errors,[])
} finally { await browser.close() }
