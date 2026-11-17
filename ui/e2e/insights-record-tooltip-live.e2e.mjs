// Real local PostgreSQL samples drive record-chart inspection; no intercepted data.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const origin=new URL(process.env.PAPRIKA_GALLERY_BASE_URL||"http://127.0.0.1:1")
assert.equal(origin.hostname,"127.0.0.1")
const output=resolve(fileURLToPath(new URL("../../",import.meta.url)),"artifacts/insights/record-tooltip-live")
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true})
try {
  for(const theme of ["light","dark"]) for(const width of [1512,390]) {
    const context=await browser.newContext({viewport:{width,height:950},colorScheme:theme,reducedMotion:"reduce",...(width===390?{hasTouch:true,isMobile:true}:{})})
    await context.addInitScript(({expected,theme})=>{if(location.origin===expected)localStorage.setItem("paprika-insights-theme",theme)},{expected:origin.origin,theme})
    const page=await context.newPage(), replies=[],errors=[],writes=[]
    page.on("pageerror",error=>errors.push(error.message))
    page.on("response",response=>{
      if(new URL(response.url()).pathname==="/api/insights/query"&&response.ok())try{const request=JSON.parse(response.request().postDataJSON().query);if(request.sql?.includes("FROM gallery.company_history WHERE symbol=$1"))replies.push(response.json())}catch{}
      if(["PUT","POST","PATCH","DELETE"].includes(response.request().method())&&/\/api\/insights\/(dashboards|saved-queries)\//.test(new URL(response.url()).pathname))writes.push(response.request().method())
    })
    const paths=["/api/insights/dashboards/local-gallery-market-lens","/api/insights/saved-queries/local-market-company-history"]
    const etag=response=>response.headers()["x-paprika-document-etag"]??response.headers().etag
    try {
      const before=await Promise.all(paths.map(path=>context.request.get(origin.origin+path)))
      assert.ok(before.every(response=>response.ok()&&etag(response)))
      const url=new URL("/dashboard/insights/",origin);url.searchParams.set("dashboard","local-gallery-market-lens");url.searchParams.set("from",new Date(Date.now()-24*3600_000).toISOString());url.searchParams.set("to",new Date().toISOString())
      await page.goto(url.href,{waitUntil:"networkidle"})
      const tile=page.locator('[data-widget-id="selected-company-history"]');await tile.scrollIntoViewIfNeeded()
      const chart=tile.getByRole("group",{name:"Selected company · short interest history"})
      const marks=chart.locator("circle[data-record-mark]");await marks.first().waitFor({timeout:30000});assert.ok(await marks.count()>2)
      await page.waitForLoadState("networkidle");assert.ok(replies.length);const count=replies.length,frame=(await replies.at(-1)).records
      const x=frame.columns.findIndex(column=>column.key==="day"),y=frame.columns.findIndex(column=>column.key==="short_interest")
      const rows=frame.rows.filter(row=>row[y]!==null).toSorted((a,b)=>Date.parse(a[x])-Date.parse(b[x]))
      const position=async index=>marks.nth(index).evaluate(element=>{const box=element.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})
      const first=await position(0)
      if(width===390)await page.touchscreen.tap(first.x,first.y);else await page.mouse.move(first.x,first.y)
      const tip=page.getByRole("tooltip");await tip.waitFor()
      const sample=tip.locator("[data-record-observation]")
      assert.equal(Number(await sample.getAttribute("data-record-observation")),Date.parse(rows[0][x]))
      assert.match(await tip.innerText(),new RegExp(Number(rows[0][y]).toFixed(2).replace(".","\\.")))
      if(width===1512){
        const second=await position(1);await page.mouse.move(second.x,second.y)
        await page.waitForFunction(expected=>Number(document.querySelector('[role="tooltip"] [data-record-observation]')?.getAttribute("data-record-observation"))===expected,Date.parse(rows[1][x]))
        assert.equal(Number(await sample.getAttribute("data-record-observation")),Date.parse(rows[1][x]),"Moving across samples updates the preview")
      }else assert.match(await tip.innerText(),/Pinned/)
      await page.keyboard.press("Escape");await tip.waitFor({state:"hidden"})
      await page.evaluate(()=>document.activeElement?.blur?.());await chart.focus();await tip.waitFor();await chart.press("ArrowRight")
      assert.equal(Number(await sample.getAttribute("data-record-observation")),Date.parse(rows[1][x]))
      await chart.press("Enter");assert.match(await tip.innerText(),/Pinned/)
      const tooltipBounds=await tip.boundingBox(),canvasBounds=await page.getByTestId("dashboard-canvas").boundingBox()
      assert.ok(tooltipBounds&&canvasBounds)
      assert.ok(tooltipBounds.x>=Math.max(0,canvasBounds.x)-1,"The inspector must stay out of dashboard navigation")
      assert.ok(tooltipBounds.x+tooltipBounds.width<=Math.min(width,canvasBounds.x+canvasBounds.width)+1,"The inspector must stay inside the visible canvas")
      await page.screenshot({path:resolve(output,`record-tooltip-${theme}-${width}.png`),animations:"disabled"})
      await page.keyboard.press("Escape");await tip.waitFor({state:"hidden"})
      assert.equal(replies.length,count,"Inspection never reissues the provider query")
      const after=await Promise.all(paths.map(path=>context.request.get(origin.origin+path)))
      assert.deepEqual(after.map(etag),before.map(etag));assert.deepEqual(writes,[]);assert.deepEqual(errors,[])
      console.log(`PASS ${theme} ${width}px: exact PostgreSQL record tooltip, mouse/touch, keyboard and unchanged revisions`)
    } finally {await context.close()}
  }
} finally {await browser.close()}
