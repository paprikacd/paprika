// Monitor grid browser acceptance with deterministic series and a latest-null sample.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const output = join(root,"artifacts/insights/status-grid")
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
await mkdir(output,{recursive:true})
const browser = await chromium.launch({headless:true}), errors = [], external = []
try {
  for (const width of [1512,390]) for (const theme of ["Light","Dark"]) {
    const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 1100},hasTouch:width === 390,reducedMotion:"reduce"})
    const page = await context.newPage(), fixture = await installRichChartFixtureAPI(page,base)
    page.on("pageerror",error=>errors.push(error.message))
    page.on("request",request=>{if(!request.url().startsWith(base)&&!request.url().startsWith("data:"))external.push(request.url())})
    const dashboard = fixture.documents.get("example-artboard-service-pulse"), widget = dashboard.widgets.find(widget=>widget.id==="states")
    widget.title = "Current monitor status"; widget.pluginId = "status-grid"; widget.config = {maxSeries:256}
    widget.options = { thresholds:[{value:0,color:"#e05e61",label:"Down"},{value:1,color:"#4abb74",label:"Healthy"}],showLegend:true,showTooltip:true }
    await page.route("**/api/insights/query",async route=>{
      const request=route.request().postDataJSON()
      if(!request.query.startsWith("paprika_example_ab_service_pulse_states{"))return route.fallback()
      const timestamp=request.end*1000
      const series=Array.from({length:210},(_,index)=>({name:`monitor-${String(index).padStart(3,"0")}`,labels:{service:`monitor-${index}`},points:[{timestamp:timestamp-60000,value:1},{timestamp,value:index===0?null:index===1?0:1}]}))
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({series})})
    })
    await page.goto(`${base}/dashboard/insights/?dashboard=example-artboard-service-pulse`,{waitUntil:"networkidle"})
    await page.getByRole("heading",{name:"Service Pulse · Test fixture",exact:true}).waitFor()
    await selectGammaOption(page,page.getByRole("combobox",{name:"Dashboard appearance",exact:true}),theme)
    const host=page.locator('[data-widget-id="states"]'); await host.scrollIntoViewIfNeeded()
    const cells=host.locator("[data-status-index]")
    await cells.nth(209).waitFor({state:"attached"})
    assert.equal(await cells.count(),210,"Every returned monitor is visible in the bounded grid")
    assert.equal(await cells.nth(0).getAttribute("data-status-value"),"unknown","A null latest sample must not revive older healthy data")
    assert.match(await cells.nth(0).evaluate(node=>getComputedStyle(node).backgroundImage),/repeating-linear-gradient/)
    assert.equal(await host.locator('[data-status-index][tabindex="0"]').count(),1,"The monitor grid has one keyboard stop")
    const box=await cells.nth(1).boundingBox(); assert.ok(box&&box.width>=10&&box.height>=10,"Status cells must be individually hoverable")
    if (width === 390) assert.ok(box.width>=24&&box.height>=24,"Touch targets are at least 24px")
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
    const tooltip=page.getByRole("tooltip"); await tooltip.waitFor()
    assert.match(await tooltip.innerText(),/Down/)
    assert.equal(await tooltip.locator("[data-metric-value]").getAttribute("data-metric-value"),"0")
    const geometry=await tooltip.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,parent:node.parentElement===document.body}})
    assert.ok(geometry.parent && geometry.left>=0 && geometry.top>=0 && geometry.right<=geometry.width+1 && geometry.bottom<=geometry.height+1,"Tooltip escapes the widget and fits in the viewport")
    await cells.nth(0).focus(); await page.keyboard.press("ArrowRight")
    assert.equal(await host.locator('[data-status-index="1"]').evaluate(node=>node===document.activeElement),true,"Arrow keys navigate exact monitors")
    await page.keyboard.press("Enter"); assert.equal(await cells.nth(1).getAttribute("aria-pressed"),"true")
    await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"})
    if (width === 390) {
      await cells.nth(0).tap(); await tooltip.getByText("No data",{exact:true}).waitFor(); await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"})
      const region=host.getByRole("region",{name:"Current monitor status monitor statuses"})
      await host.getByText("Scroll to see all monitors",{exact:true}).waitFor()
      await region.focus(); assert.equal(await region.getAttribute("tabindex"),"0")
      await page.keyboard.press("PageDown")
      await page.waitForFunction(() => document.querySelector('[data-status-overflow="true"]')?.scrollTop > 0)
      await page.setViewportSize({width:3000,height:1100})
      await host.getByText("Scroll to see all monitors",{exact:true}).waitFor({state:"hidden"})
      await page.setViewportSize({width:390,height:844})
      await host.getByText("Scroll to see all monitors",{exact:true}).waitFor()
    }
    assert.deepEqual(fixture.failures,[])
    await page.mouse.move(0,0)
    await host.scrollIntoViewIfNeeded()
    await page.keyboard.press("Escape")
    await page.getByRole("tooltip").waitFor({state:"hidden"})
    await page.screenshot({path:join(output,`${theme.toLowerCase()}-${width}.png`),fullPage:false,animations:"disabled"})
    await context.close(); console.log(`PASS ${theme} ${width}px monitor status grid`)
  }
  assert.deepEqual(errors,[]); assert.deepEqual(external,[])
} finally { await browser.close() }
