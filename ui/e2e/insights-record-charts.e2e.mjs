// Renderer integration uses the shipped, attributed catalog records. No live provider is mocked or claimed.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve, join } from "node:path"
import { chromium } from "playwright"

const root=resolve(fileURLToPath(new URL("../../",import.meta.url)))
const base=process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output=join(root,"artifacts/insights/record-charts")
const catalog=JSON.parse(await readFile(join(root,"ui/src/features/insights/repository-examples/catalog.json"),"utf8"))
const dashboard={schemaVersion:1,id:"record-chart-validation",title:"Record chart validation",timeRange:"1h",refreshInterval:0,variables:[{name:"selected",label:"Selected signal",defaultValue:""}],widgets:[]}
function source(entryId,widgetId){
  const board=catalog.find(entry=>entry.id===entryId).sample.dashboards[0]
  const widget=structuredClone(board.widgets.find(item=>item.id===widgetId))
  delete widget.queryRef
  for(const variable of board.variables ?? [])widget.query=widget.query.replaceAll(`{{${variable.name}}}`,JSON.stringify(variable.defaultValue))
  return widget
}
const line=source("shorted-housing-feature","policy-price")
const bars={...structuredClone(line),id:"bar-validation",title:"Complete grouped bars",pluginId:"records-bar"}
const pie=source("shorted-operations","p10-t0")
const history=source("paprika-signal-features","states")
dashboard.widgets=[bars,line,pie,history].map((widget,index)=>({...widget,layout:{x:index%2*6,y:Math.floor(index/2)*5,w:6,h:5},drilldowns:[{id:"inspect",title:"Inspect selection",dashboardId:dashboard.id,bindings:[{variable:"selected",source:"series"}]}]}))
const browser=await chromium.launch({headless:true}), reports=[],errors=[]
await mkdir(output,{recursive:true})
try{
  for(const theme of ["light","dark"]){
    const context=await browser.newContext({viewport:{width:1440,height:1100}})
    await context.addInitScript(({origin,dashboard,theme})=>{
      if(location.origin!==origin)return
      localStorage.setItem("paprika-insights-example-v1",JSON.stringify({dashboards:[dashboard],activeId:dashboard.id}))
      localStorage.setItem("paprika-insights-theme",theme)
    },{origin:new URL(base).origin,dashboard,theme})
    const page=await context.newPage()
    page.on("pageerror",error=>errors.push(error.message))
    await page.goto(`${base}/dashboard/insights/?example=1&dashboard=${dashboard.id}`)
    await page.getByRole("heading",{name:dashboard.title,exact:true}).waitFor()
    for(const widget of dashboard.widgets){
      const tile=page.locator(`[data-widget-id="${widget.id}"]`)
      await tile.scrollIntoViewIfNeeded()
      const mark=widget.pluginId==="status-history"?tile.getByRole('button', {name: /.+/}).and(tile.locator('[data-history-key]')).first():tile.locator('svg [role="button"]').first()
      await mark.waitFor()
      if (widget.pluginId === "status-history") {
        const label = await mark.getAttribute("aria-label")
        assert.ok(label?.includes(" · "), "History marks expose the recorded series, time and value in their accessible name")
        await mark.focus()
        await mark.press("Enter")
        assert.equal(await mark.getAttribute("aria-pressed"), "true", "Keyboard activation pins the recorded history observation")
        await mark.press("Enter")
        assert.equal(await mark.getAttribute("aria-pressed"), null, "Keyboard activation can dismiss the pinned observation")
      }
      assert.deepEqual(await tile.getByRole("alert").allTextContents(),[])
    }
    const barTile=page.locator('[data-widget-id="bar-validation"]')
    const bounds=await barTile.evaluate(element=>{
      const clip=element.querySelector("clipPath rect")
      const left=Number(clip.getAttribute("x")),right=left+Number(clip.getAttribute("width"))
      const bars=[...element.querySelectorAll('rect[role="button"]')]
      return {count:bars.length,complete:bars.every(bar=>Number(bar.getAttribute("x"))>=left && Number(bar.getAttribute("x"))+Number(bar.getAttribute("width"))<=right)}
    })
    assert.ok(bounds.count>2 && bounds.complete,"First and last grouped bars must be fully visible")
    const lineTile=page.locator('[data-widget-id="policy-price"]')
    assert.ok(await lineTile.locator('line[stroke-dasharray="3 3"]').count()>0,"Authored policy annotations are visible")
    assert.ok((await lineTile.innerText()).includes("right axis"),"Dual-axis series have a visible axis label")
    const selected=lineTile.locator('circle[role="button"]').first()
    await selected.focus();await selected.press("Enter")
    assert.ok(await selected.evaluate(element=>document.activeElement===element),"Chart points support keyboard selection")
    await lineTile.getByRole("status").filter({hasText:/Selected:/}).waitFor()
    await page.evaluate(()=>scrollTo(0,0))
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false)
    await page.screenshot({path:join(output,`desktop-${theme}.png`),fullPage:true})
    await page.setViewportSize({width:390,height:844})
    for(const widget of dashboard.widgets){
      const tile=page.locator(`[data-widget-id="${widget.id}"]`)
      await tile.scrollIntoViewIfNeeded()
      assert.deepEqual(await tile.getByRole("alert").allTextContents(),[])
    }
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-widget-id="bar-validation"] svg[role="group"], [data-widget-id="policy-price"] svg[role="group"]')].every(svg=>Math.abs(svg.viewBox.baseVal.width-svg.getBoundingClientRect().width)<1))
    const tickSize=await lineTile.locator("svg text").first().evaluate(element=>{
      const matrix=element.getScreenCTM()
      return parseFloat(getComputedStyle(element).fontSize)*Math.min(Math.abs(matrix.a),Math.abs(matrix.d))
    })
    assert.ok(tickSize>=9,"Mobile axis text must stay readable instead of shrinking with a desktop SVG")
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,"Mobile charts must not widen the page")
    await page.evaluate(()=>scrollTo(0,0))
    await page.screenshot({path:join(output,`mobile-${theme}.png`),fullPage:true})
    reports.push({theme,passed:true,bars:bounds.count,desktop:true,mobile:true})
    console.log(`PASS ${theme}: bars, dual axes, annotations, pie/history and keyboard selection at desktop/mobile sizes`)
    await context.close()
  }
  assert.deepEqual(errors,[])
}catch(error){process.exitCode=1;console.error(error.stack)}finally{
  await writeFile(join(output,"report.json"),JSON.stringify({passed:!process.exitCode,reports,errors},null,2))
  await browser.close()
}
