// Exercise the shipped catalog in a fresh browser, not a separate renderer fixture.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve, join } from "node:path"
import { chromium } from "playwright"

const root=resolve(fileURLToPath(new URL("../../",import.meta.url)))
const base=process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output=join(root,"artifacts/insights/repository-examples/browser")
const catalog=JSON.parse(await readFile(join(root,"ui/src/features/insights/repository-examples/catalog.json"),"utf8"))
const reports=[],errors=[],liveRequests=[]
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000}})
const page=await context.newPage()
page.on("pageerror",error=>errors.push(error.message))
page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/insights"))liveRequests.push(new URL(request.url()).pathname)})
async function check(name,run){await run();reports.push({name,passed:true});console.log(`PASS ${name}`)}
async function open(dashboard,theme){
  await page.goto(`${base}/dashboard/insights/?example=1&dashboard=${encodeURIComponent(dashboard.id)}`)
  await page.getByRole("heading",{name:dashboard.title,exact:true}).waitFor()
  await page.evaluate(value=>{localStorage.setItem("paprika-insights-theme",value);window.dispatchEvent(new Event("paprika-insights-theme-change"))},theme)
}
try{
  for(const theme of ["light","dark"]){
    for(const entry of catalog){for(const dashboard of entry.sample.dashboards){
      await check(`${theme}: ${dashboard.title} renders every source widget`,async()=>{
        await open(dashboard,theme)
        for(const widget of dashboard.widgets){
          const tile=page.locator(`[data-widget-id="${widget.id}"]`)
          await tile.scrollIntoViewIfNeeded()
          await tile.getByRole("status",{name:"Loading widget"}).waitFor({state:"hidden",timeout:20000})
          // Allow the query effect after an intersection becomes visible.
          await page.waitForFunction(id=>{const element=document.querySelector(`[data-widget-id="${id}"]`);return element && !element.querySelector('[aria-busy="true"]')},widget.id)
          const alerts=await tile.getByRole("alert").allTextContents()
          assert.deepEqual(alerts,[],`${dashboard.id}/${widget.id}: ${alerts.join(" ")}`)
          assert.ok((await tile.innerText()).trim().length>widget.title.length,"Widget has no visible content")
        }
        const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)
        assert.equal(overflow,false,"Dashboard widened the viewport")
        await page.evaluate(()=>scrollTo(0,0))
        await page.screenshot({path:join(output,`${dashboard.id}-${theme}.png`)})
      })
    }}
  }
  await check("Gallery exposes provenance and portable query closure",async()=>{
    await page.getByRole("button",{name:new RegExp(`^Examples ${catalog.length}$`)}).click()
    await page.getByRole("region",{name:"Repository examples"}).waitFor()
    const entry=catalog.find(item=>item.id==="uptime-overview")
    await page.getByRole("textbox",{name:"Find an example"}).fill(entry.title)
    await page.getByRole("button").filter({has:page.getByText(entry.title,{exact:true})}).click()
    await page.getByText("Source provenance",{exact:true}).click()
    assert.ok((await page.getByRole("region",{name:"Repository examples"}).innerText()).includes(entry.source.revision))
    const saved=page.waitForEvent("download")
    await page.getByRole("button",{name:"Download bundle"}).click()
    const download=await saved
    const path=await download.path()
    const exported=JSON.parse(await readFile(path,"utf8"))
    assert.equal(exported.kind,"PaprikaDashboardLibrary")
    assert.equal(exported.schemaVersion,1)
    assert.deepEqual(exported.dashboards,entry.sample.dashboards)
    assert.deepEqual(exported.savedQueries,entry.sample.savedQueries)
    await page.getByRole("button",{name:"Close examples"}).click()
  })
  await check("Existing edited workspace survives reload",async()=>{
    const queriesBefore=await page.evaluate(()=>JSON.parse(localStorage.getItem("paprika.insights.example-queries.v1")))
    assert.ok(Array.isArray(queriesBefore) && queriesBefore.length>0,"Seeded queries must persist independently of dashboard references")
    const dashboard=catalog[0].sample.dashboards[0]
    await page.evaluate(value=>localStorage.setItem("paprika-insights-example-v1",JSON.stringify({dashboards:[{...value,title:"My preserved example"}],activeId:value.id})),dashboard)
    await page.goto(`${base}/dashboard/insights/?example=1&dashboard=${dashboard.id}`)
    await page.getByRole("heading",{name:"My preserved example",exact:true}).waitFor()
    const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem("paprika-insights-example-v1")))
    assert.equal(stored.dashboards.length,1)
    assert.equal(stored.dashboards[0].title,"My preserved example")
    const queriesAfter=await page.evaluate(()=>JSON.parse(localStorage.getItem("paprika.insights.example-queries.v1")))
    assert.deepEqual(queriesAfter,queriesBefore,"Removing dashboards must preserve orphaned saved queries and their versions")
  })
  await check("Sample mode makes no live provider requests and has no runtime errors",async()=>{assert.deepEqual(liveRequests,[]);assert.deepEqual(errors,[])})
}catch(error){
  await page.screenshot({path:join(output,"failure.png"),fullPage:true}).catch(()=>{})
  await writeFile(join(output,"failure.txt"),`${error.stack}\n${await page.locator("body").innerText()}\n${JSON.stringify(errors)}`)
  process.exitCode=1
  console.error(error.message)
}finally{
  await writeFile(join(output,"report.json"),JSON.stringify({reports,errors,liveRequests},null,2))
  await context.close();await browser.close()
}
