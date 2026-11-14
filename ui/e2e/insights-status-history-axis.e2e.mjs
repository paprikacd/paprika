// Exercise the shared time scale and label projection through actual provider responses.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { fillFloor, focusRingEvidence, markFillEvidence } from "./fixtures/mark-fill.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const output = join(root,"artifacts/insights/status-history-axis")
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true}), errors=[]
try {
  for (const width of [1512,390]) for (const theme of ["Light","Dark"]) {
    const context=await browser.newContext({viewport:{width,height:width===390?844:1100},hasTouch:width===390,reducedMotion:"reduce",deviceScaleFactor:2})
    const page=await context.newPage(), fixture=await installRichChartFixtureAPI(page,base)
    page.on("pageerror",error=>errors.push(error.message))
    const dashboard=fixture.documents.get("example-artboard-service-pulse"), widget=dashboard.widgets.find(widget=>widget.id==="states")
    dashboard.timeZone="Australia/Melbourne"
    fixture.savedQueries.set("test-incidents",{schemaVersion:1,id:"test-incidents",name:"Recorded incidents",providerId:"example-records",kind:"records",query:'{"fixture":"test-incident"}'})
    const chart=dashboard.widgets.find(widget=>widget.id==="request-history")
    chart.annotationSource={queryRef:{id:"test-incidents"},timestampColumn:"started_at",endColumn:"ended_at",labelColumn:"label",severityColumn:"severity"}
    chart.options={...chart.options,thresholds:[{value:2,color:"#e0a527",label:"2× threshold"}]}
    widget.title="Service SLO state timeline"; widget.pluginId="status-history"; widget.config={maxSeries:8,maxPoints:60,labelField:"service",showTimeAxis:true,segmented:true}
    widget.options={thresholds:[{value:0,status:"ok",label:"Healthy"},{value:1,status:"warning",label:"At risk"},{value:2,status:"critical",label:"Breaching"}],showLegend:true,showTooltip:true}
    await page.route("**/api/insights/query",async route=>{
      const request=route.request().postDataJSON()
      if(request.query === '{"fixture":"test-incident"}') {
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({records:{columns:[{key:"started_at",type:"timestamp"},{key:"ended_at",type:"timestamp"},{key:"label",type:"string"},{key:"severity",type:"string"}],rows:[[new Date((request.end-1800)*1000).toISOString(),new Date((request.end-1200)*1000).toISOString(),"Database incident","critical"]]}})})
      }
      if(request.query.startsWith("paprika_example_ab_service_pulse_requests{")) {
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({series:[{name:"burn",labels:{service:"uptime-api"},points:Array.from({length:61},(_,index)=>({timestamp:(request.start+(request.end-request.start)*index/60)*1000,value:7.9+0.2*index/60}))}]})})
      }
      if(!request.query.startsWith("paprika_example_ab_service_pulse_states{")) return route.fallback()
      // 30 samples leave ~10 px marks at 1512 px, so critical samples are framed; 60 leave ~5 px marks at 390 px, unframed.
      const end=request.end*1000, start=end-30*24*60*60*1000, points=width===1512?30:60
      const series=["uptime-api","payment-api","auth-api","catalog-api","worker"].map((name,row)=>({name:`up{service="${name}"}`,labels:{service:name},points:Array.from({length:points},(_,i)=>({timestamp:start+i*(end-start)/(points-1),value:i===10&&row===1?2:i===16&&row===2?1:0}))}))
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
    const axis=host.getByRole("group",{name:"Status history time scale in Australia/Melbourne"})
    assert.equal(await axis.locator("time").count(),5)
    const times=await axis.locator("time").evaluateAll(nodes=>nodes.map(node=>Date.parse(node.dateTime)))
    assert.equal(await axis.locator("time").first().innerText(), new Intl.DateTimeFormat(undefined,{timeZone:"Australia/Melbourne",month:"short",day:"numeric"}).format(times[0]))
    assert.equal(times[4]-times[0],30*24*60*60*1000)
    const incident=rows.nth(1).getByRole("button",{name:/Breaching/}); await incident.focus()
    await page.keyboard.press("Enter")
    const tooltip=page.getByRole("tooltip"); await tooltip.waitFor()
    // The status label can paint after the tooltip itself on a slow runner, so wait for it before reading the text.
    await tooltip.getByText(/Breaching/).first().waitFor()
    assert.match(await tooltip.innerText(),/Breaching/)
    assert.equal(await tooltip.locator("[data-metric-value]").getAttribute("data-metric-value"),"2")
    await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"})
    assert.deepEqual(fixture.failures,[])
    // Critical fill, counted from pixels: framed marks keep a fill centre, unframed marks are almost all fill.
    // Frames only appear on marks 7 px or wider, so the 60-point series exercises both branches at 390 px.
    const criticalMarks=host.locator('[data-history-value="2"]')
    const checkCritical=async label=>{
      const marks=[]
      for(let index=0;index<await criticalMarks.count();index++){
        const mark=criticalMarks.nth(index)
        // A frame belongs to the contiguous critical run that covers the sample; a run of one frames that sample.
        const framed=await mark.evaluate(node=>{const m=node.getBoundingClientRect();return [...node.parentElement.querySelectorAll('[data-status-run="critical"]')].some(run=>{const r=run.getBoundingClientRect();return r.left<=m.left+0.5&&r.right>=m.right-0.5})})
        // Sample the focused state (a keyboard user leaves the mark focused) and the resting state. A cover from
        // either state must fail, so both are composited and both must clear the floor.
        const focused=await markFillEvidence(page,mark,{trimRight:1,framed})
        await mark.evaluate(node=>node.blur())
        const resting=await markFillEvidence(page,mark,{trimRight:1,framed})
        marks.push({...focused,state:"focused"},{...resting,state:"resting"})
      }
      assert.ok(marks.length>0,`${label}: the fixture has critical marks`)
      for(const mark of marks){
        assert.equal(mark.centreIsFill,true,`${label} (${mark.state}): a critical mark's centre is its fill, not a frame or gap: ${JSON.stringify(mark)}`)
        assert.ok(mark.total>0&&mark.fill/mark.total>=fillFloor(mark),`${label} (${mark.state}): ${mark.framed?"framed":"unframed"} critical mark fill ${(mark.fill/mark.total).toFixed(2)} is below ${fillFloor(mark)}: ${JSON.stringify(mark)}`)
      }
      const framedCount=marks.filter(mark=>mark.framed&&mark.state==="resting").length
      if(width===1512) assert.ok(framedCount>0,`${label}: the 30-sample fixture yields framed critical marks`)
      if(width===390) assert.equal(framedCount,0,`${label}: thin marks at 390 px carry no frame`)
      console.log(`  ${label}: ${marks.filter(mark=>mark.state==="resting").length} critical marks, ${framedCount} framed; fill focused ${marks.filter(mark=>mark.state==="focused").map(mark=>(mark.fill/mark.total).toFixed(2)).join(", ")} / resting ${marks.filter(mark=>mark.state==="resting").map(mark=>(mark.fill/mark.total).toFixed(2)).join(", ")}`)
    }
    // Keyboard focus shows a ring outside the sample, above the run frame: inside a framed run and outside any run.
    const checkRings=async label=>{
      for(const [what,mark] of [["focused in run",criticalMarks.first()],["focused outside run",host.locator('[data-history-value="0"]').first()]]){
        await page.keyboard.press("Shift")
        await mark.focus()
        const ring=await focusRingEvidence(page,mark)
        await mark.evaluate(node=>node.blur())
        assert.equal(ring.found,true,`${label} ${what}: a focused sample has a focus ring`)
        assert.ok(ring.ringPixelsLeft+ring.ringPixelsRight>=4,`${label} ${what}: the ring is visible on the sample's sides: ${JSON.stringify(ring)}`)
        assert.ok(ring.contrast>=3,`${label} ${what}: ring contrast ${ring.contrast.toFixed(2)}:1 is below 3:1 against its surroundings`)
        console.log(`  ${label} ${what}: ring ${ring.ringPixelsLeft}/${ring.ringPixelsRight} device px left/right, contrast ${ring.contrast.toFixed(2)}:1`)
      }
    }
    await page.mouse.move(0,0)
    await checkCritical(`${theme} ${width}px`)
    await checkRings(`${theme} ${width}px`)
    if(width===1512&&theme==="Dark"){
      const compact=page.getByRole("button",{name:"Compact view",exact:true})
      assert.equal(await compact.isEnabled(),true,"Compact view is available on the wide canvas")
      await compact.click()
      await page.waitForFunction(()=>document.querySelector('[data-insights-theme="dark"][data-density="compact"]')!==null)
      await checkCritical("Compact dark 1512px")
      await checkRings("Compact dark 1512px")
    }
    await page.screenshot({path:join(output,`${theme.toLowerCase()}-${width}.png`),animations:"disabled"})
    await context.close(); console.log(`PASS ${theme} ${width}px status history`)
  }
  assert.deepEqual(errors,[])
} finally { await browser.close() }
