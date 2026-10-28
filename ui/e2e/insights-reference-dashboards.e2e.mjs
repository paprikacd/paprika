// Generate reference-derived dashboards through the UI into an empty real Go
// workspace. Only telemetry responses are deterministic; document writes are real.
import assert from "node:assert/strict"
import { mkdir, writeFile, copyFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { until } from "./insights-portable-fixture.mjs"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"
import { referenceDashboards, resultForReferenceQuery } from "./fixtures/reference-dashboard-data.ts"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const output = join(repository, "artifacts/insights/reference-dashboards")
const staticURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const reports = [], errors = [], writes = [], comparisons = []
let environment, browser, context, page, persisted
const tile = id => page.locator(`[data-widget-id=${JSON.stringify(id)}]`)
const escaped = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char])

async function check(name, action) {
  const started = Date.now()
  try { const evidence = await action(); reports.push({name, passed:true, milliseconds:Date.now()-started, evidence}); console.log(`PASS ${name}`) }
  catch(error) { reports.push({name,passed:false,error:error.stack}); await page?.screenshot({path:join(output,"failure.png")}).catch(()=>{}); throw error }
}
async function newPage(viewport = {width:1600,height:1100}) {
  await context?.close()
  context = await browser.newContext({viewport,reducedMotion:"reduce",timezoneId:"UTC"})
  page = await context.newPage(); page.setDefaultTimeout(15000)
  await environment.installQueryFixture(page,resultForReferenceQuery)
  page.on("pageerror",error=>errors.push(error.message))
  page.on("dialog",dialog=>{errors.push(`Unexpected ${dialog.type()}`);void dialog.dismiss()})
  page.on("response",response=>{
    const request=response.request(), path=new URL(response.url()).pathname
    if(request.method()==="PUT" && /^\/api\/insights\/(dashboards|saved-queries)\//.test(path))
      writes.push({path,status:response.status(),document:request.postDataJSON(),conditional:request.headers()["if-none-match"]??request.headers()["if-match"]})
  })
}
async function loadBoard(board, theme="Dark") {
  await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${encodeURIComponent(board.id)}`,{waitUntil:"networkidle"})
  await page.getByRole("heading",{name:board.title,exact:true}).waitFor()
  await selectGammaOption(page,page.getByRole("combobox",{name:"Dashboard appearance",exact:true}),theme)
  const sidebar=page.getByRole("button",{name:"Toggle sidebar",exact:true})
  if(await sidebar.getAttribute("aria-expanded")==="true")await sidebar.click()
}
async function renderEveryPanel(board) {
  for(const widget of board.widgets) {
    const element=tile(widget.id)
    await element.scrollIntoViewIfNeeded()
    await until(async()=>!(await element.locator('[aria-busy="true"]').count()) && !/Querying data source|No data in this time range/.test(await element.innerText()),`${widget.title} did not render`,20000)
    assert.deepEqual(await element.getByRole("alert").allTextContents(),[],widget.title)
    if(widget.type==="stat")assert.ok(await element.locator("[data-metric-value]").count(),`${widget.title} needs a real observed value`)
    else assert.ok(await element.locator("svg,table,[role=region]").count(),`${widget.title} needs a rendered chart or table`)
    if(widget.config?.seriesMode==="all") {
      const bank=element.locator("[data-gauge-bank-display]")
      assert.equal(await bank.locator("[data-gauge-series]").count(),widget.config.maxSeries,"Reference capacity panels must display every distinct series")
      const measurements=await bank.evaluate(node=>({height:node.clientHeight,content:node.scrollHeight}))
      if(page.viewportSize().width>=1200)assert.ok(measurements.content<=measurements.height+1,`${widget.title}: all gauges must fit their panel without scrolling`)
    }
    if(widget.pluginId==="status-history" && page.viewportSize().width>=1200) {
      const lanes=await element.locator("[data-history-series]").evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(),p=node.closest('[role="region"]').getBoundingClientRect();return{top:r.top,bottom:r.bottom,clipTop:p.top,clipBottom:p.bottom}}))
      assert.equal(lanes.length,6,"The reference contains six host-state lanes")
      assert.ok(lanes.every(lane=>lane.top>=lane.clipTop&&lane.bottom<=lane.clipBottom+1),"All six host-state lanes must be visible without scrolling")
    }
    if(widget.id==="reference-service-overview-flow-readings" && page.viewportSize().width>=1200) {
      const visible=await element.getByRole("region",{name:`${widget.title} records`,exact:true}).evaluate(region=>{const bounds=region.getBoundingClientRect();return [...region.querySelectorAll("tbody tr")].map(row=>row.getBoundingClientRect()).filter(row=>row.top>=bounds.top&&row.bottom<=bounds.bottom+1).length})
      assert.equal(visible,5,"All five flow readings must fit the reference panel")
    }
    if(widget.pluginId==="records-line" && page.viewportSize().width>=1200) {
      assert.ok(Number(await element.locator("[data-record-plot-height]").getAttribute("data-record-plot-height"))>=65,"Dual-axis record charts retain at least65px drawable height")
    }
    if(widget.type==="timeseries" && page.viewportSize().width>=1200) {
      const plot=element.locator("svg").first()
      assert.ok((await plot.boundingBox()).height>=98,"Time-series plots retain at least65px drawable height after axes")
    }
    if(widget.pluginId==="distribution-heatmap") {
      const ticks=await element.locator("text[data-value-axis]").evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom}}).sort((a,b)=>a.top-b.top))
      assert.ok(ticks.length>=2,"Heatmap retains a useful bucket axis")
      for(let index=1;index<ticks.length;index++)assert.ok(ticks[index].top>=ticks[index-1].bottom,"Heatmap bucket labels must not overlap")
    }
    if(widget.pluginId==="connection-map")assert.equal(await element.locator("[data-geographic-land]").count(),1,"Map needs geographic context, not only coordinates")
  }
}
async function geometry(board,oneScreen) {
  await page.evaluate(()=>window.scrollTo(0,0))
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const measured=await page.evaluate(()=>{
    const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}}
    return{viewport:{width:innerWidth,height:innerHeight},overflow:document.documentElement.scrollWidth-innerWidth,canvas:rect(document.querySelector('[data-testid="dashboard-canvas"]')),widgets:[...document.querySelectorAll("[data-widget-id]")].map(el=>({id:el.dataset.widgetId,...rect(el)}))}
  })
  assert.equal(measured.widgets.length,board.widgets.length)
  assert.ok(measured.overflow<=1,"No horizontal document overflow")
  for(const widget of measured.widgets)assert.ok(widget.width>=70&&widget.height>=110,`${widget.id} collapsed`)
  for(let a=0;a<measured.widgets.length;a++)for(let b=a+1;b<measured.widgets.length;b++) {
    const first=measured.widgets[a],second=measured.widgets[b]
    assert.ok(Math.min(first.right,second.right)-Math.max(first.x,second.x)<=1 || Math.min(first.bottom,second.bottom)-Math.max(first.y,second.y)<=1,`${first.id} overlaps ${second.id}`)
  }
  if(oneScreen)assert.ok(measured.canvas.bottom<=measured.viewport.height+1,`Reference composition should fit one screen: bottom ${measured.canvas.bottom}, viewport ${measured.viewport.height}`)
  return measured
}
async function captureBoard(spec,board,theme) {
  const width=page.viewportSize().width
  await page.evaluate(()=>window.scrollTo(0,0))
  const shots=[]
  let position=0,index=0
  do {
    await page.evaluate(y=>window.scrollTo(0,y),position)
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const name=`${spec.id}-${theme.toLowerCase()}-${width}-${index++}.png`
    await page.screenshot({path:join(output,name)})
    shots.push(name)
    const dimensions=await page.evaluate(()=>({scroll:scrollY,height:innerHeight,total:document.documentElement.scrollHeight}))
    if(width<600 || dimensions.scroll+dimensions.height>=dimensions.total-1)break
    position=dimensions.scroll+dimensions.height-60
  }while(index<5)
  comparisons.push({id:spec.id,title:spec.title,referenceKey:spec.referenceKey,theme,width,shots,approximations:spec.approximations})
  return shots
}
async function snapshotStore(){return{dashboards:(await environment.api("dashboards")).document.dashboards,queries:(await environment.api("saved-queries")).document.queries}}
function withoutETag(document){const value={...document};delete value.etag;return value}

await mkdir(output,{recursive:true})
try {
  environment=await createReferenceDashboardEnvironment(repository,staticURL)
  browser=await chromium.launch({headless:true})
  await newPage()
  const generated={kind:"PaprikaDashboardLibrary",schemaVersion:1,dashboards:[],savedQueries:[]}
  for(const reference of referenceDashboards) {
    const bundle=structuredClone(reference.bundle)
    for(const query of bundle.savedQueries)query.providerId=environment.providerIds[query.kind]
    for(const board of bundle.dashboards)for(const widget of board.widgets)widget.providerId=environment.providerIds[widget.dataKind??(widget.type==="traces"?"traces":"metrics")]
    generated.dashboards.push(...bundle.dashboards);generated.savedQueries.push(...bundle.savedQueries)
  }
  await writeFile(join(output,"generated-dashboard-bundle.json"),JSON.stringify(generated,null,2))
  await check("Generate four reference dashboards through UI import into empty real storage",async()=>{
    const initial=await snapshotStore();assert.equal(initial.dashboards.length,0);assert.equal(initial.queries.length,0)
    await page.goto(`${environment.baseURL}/dashboard/insights/`,{waitUntil:"networkidle"})
    await page.getByRole("button",{name:"Manage dashboards",exact:true}).click()
    const importer=page.getByRole("region",{name:"Portable dashboard import",exact:true})
    await selectGammaOption(page,importer.getByRole("combobox",{name:"Library import format",exact:true}),"JSON")
    await importer.getByRole("textbox",{name:"Library import source",exact:true}).fill(JSON.stringify(generated))
    await importer.getByRole("button",{name:"Review import",exact:true}).click()
    await importer.getByRole("button",{name:"Import 4 as new",exact:true}).click()
    await importer.getByText(/^4 dashboard decisions completed\./).waitFor({timeout:60000})
    await page.getByRole("button",{name:"Close dashboard manager",exact:true}).click()
    persisted=await snapshotStore()
    assert.equal(persisted.queries.length,generated.savedQueries.length)
    for(const source of generated.dashboards) {
      const saved=persisted.dashboards.find(board=>board.title===source.title)
      assert.ok(saved,source.title);assert.deepEqual(saved.variables,source.variables)
      assert.deepEqual(saved.widgets.map(w=>({id:w.id,layout:w.layout,pluginId:w.pluginId,config:w.config})),source.widgets.map(w=>({id:w.id,layout:w.layout,pluginId:w.pluginId,config:w.config})))
      for(const widget of saved.widgets)assert.ok(persisted.queries.some(query=>query.id===widget.queryRef?.id),`${widget.title} lost saved-query closure`)
    }
    for(const write of writes){assert.ok(write.status<300||write.status===429);assert.ok(write.conditional,"Creation must use conditional writes")}
    for(const receipt of new Map(writes.map(write=>[write.path,write])).values())assert.ok(receipt.status<300,"Every generated document must eventually persist")
    return{dashboards:persisted.dashboards.length,savedQueries:persisted.queries.length,writes:writes.length,emptyInitially:true}
  })
  for(const reference of referenceDashboards)for(const theme of ["Dark","Light"])await check(`${reference.title}: ${theme} reference composition at1600px`,async()=>{
    const board=persisted.dashboards.find(item=>item.title===reference.title)
    await loadBoard(board,theme);await renderEveryPanel(board)
    const shape=await geometry(board,reference.oneScreen)
    const screenshots=await captureBoard(reference,board,theme)
    const variable=board.variables[0],control=page.getByRole("form",{name:"Dashboard variables"}).getByRole("combobox",{name:variable.label,exact:true})
    const before=environment.queryCalls.length
    await selectGammaOption(page,control,variable.options[1]);await renderEveryPanel(board)
    assert.ok(environment.queryCalls.length>before,"Shared filter must issue changed queries")
    const changedCalls=environment.queryCalls.slice(before)
    assert.ok(changedCalls.every(call=>!call.request.query.includes("{{")),"All queries must resolve their parameter bindings")
    for(const widget of board.widgets) {
      const query=persisted.queries.find(item=>item.id===widget.queryRef.id)
      const expected=query.query.replaceAll("{{service}}",JSON.stringify(variable.options[1]))
      assert.ok(changedCalls.some(call=>call.request.query===expected),`${widget.title} must query the selected ${variable.label}`)
    }
    await selectGammaOption(page,control,variable.options[0])
    return{panels:board.widgets.length,shape,screenshots,approximations:reference.approximations}
  })
  await check("Generated dashboards and saved queries survive a real process restart",async()=>{
    const before=await snapshotStore();const receipt=await environment.api(`dashboards/${before.dashboards[0].id}`)
    await context.close();context=undefined;await environment.restart();await newPage()
    const after=await snapshotStore()
    assert.deepEqual(after.dashboards,before.dashboards);assert.deepEqual(after.queries.map(withoutETag),before.queries.map(withoutETag))
    const reloaded=await environment.api(`dashboards/${before.dashboards[0].id}`);assert.equal(reloaded.etag,receipt.etag)
    persisted=after
    return{dashboards:after.dashboards.length,savedQueries:after.queries.length,etagPreserved:true}
  })
  await page.setViewportSize({width:390,height:844})
  for(const reference of referenceDashboards)await check(`${reference.title}: generated dashboard remains usable on mobile`,async()=>{
    const board=persisted.dashboards.find(item=>item.title===reference.title)
    await loadBoard(board);await renderEveryPanel(board)
    const shape=await geometry(board,false)
    await captureBoard(reference,board,"Dark")
    assert.deepEqual((await environment.api(`dashboards/${board.id}`)).document.widgets.map(w=>w.layout),board.widgets.map(w=>w.layout),"Responsive reflow must not mutate the saved layout")
    return{panels:board.widgets.length,shape}
  })
  assert.deepEqual(errors,[]);assert.deepEqual(environment.failures,[])
} finally {
  await writeFile(join(output,"report.json"),JSON.stringify({reports,pageErrors:errors,queryFailures:environment?.failures??[],writes,comparisons,dataScope:"Real authenticated Go persistence; query responses are deterministic test telemetry. Screenshots require human reference review; no pixel-equivalence claim."},null,2))
  const sources={"image-1":"/var/folders/67/hnhhpcl17d3g58twcjz8w09h0000gn/T/codex-clipboard-3576a3e9-1377-493e-829a-18b2545bd80a.png","image-2":"/var/folders/67/hnhhpcl17d3g58twcjz8w09h0000gn/T/codex-clipboard-39e37762-0d41-4e67-bccb-e64bb369e081.png","image-3":"/var/folders/67/hnhhpcl17d3g58twcjz8w09h0000gn/T/codex-clipboard-c9fa678c-26c1-4b9b-acad-f681e1f1c288.png","image-4":"/var/folders/67/hnhhpcl17d3g58twcjz8w09h0000gn/T/codex-clipboard-8e02f56f-0d25-4739-8b42-d10f263f027b.png"}
  const available=[]
  for(const [key,path]of Object.entries(sources))try{await copyFile(path,join(output,`${key}.png`));available.push(key)}catch{/* User-supplied references are local evidence, not a CI dependency. */}
  await writeFile(join(output,"index.html"),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paprika reference dashboard validation</title><style>body{font:15px/1.5 system-ui;margin:0;background:#10171b;color:#edf3f5}main{max-width:1800px;margin:auto;padding:28px}h1{font-size:26px}h2{font-size:20px}section{border-top:1px solid #34414b;margin-top:32px;padding-top:20px}.comparison{display:grid;grid-template-columns:minmax(220px,1fr) 2fr;gap:20px}img{width:100%;height:auto;display:block;margin-bottom:12px}p,li{color:#b9c6ce}a{color:#8bbaff}button{font:inherit;padding:8px 16px;margin:0 8px 12px 0;background:#1c2b35;color:#edf3f5;border:1px solid #647b8a;border-radius:5px;cursor:pointer}button[aria-pressed=true]{border-color:#8bbaff;background:#293c4a}@media(max-width:800px){.comparison{grid-template-columns:1fr}}</style><main><h1>Dashboards generated from the references</h1><p>Imported through Paprika into empty, real persisted storage. All charts are live UI components with deterministic test telemetry. The supplied images guide composition and chart vocabulary; these are not pixel-identical copies.</p><p><a href="generated-dashboard-bundle.json">Generated dashboard bundle</a> · <a href="report.json">Test evidence</a> · <a href="visual-review.md">Visual review</a></p><button type="button" data-theme="dark" aria-pressed="true">Dark</button><button type="button" data-theme="light" aria-pressed="false">Light</button>${referenceDashboards.map(spec=>`<section><h2>${escaped(spec.title)}</h2><div class="comparison"><div>${available.includes(spec.referenceKey)?`<img src="${spec.referenceKey}.png" alt="User supplied ${spec.referenceKey}">`:"<p>Local reference image unavailable in this environment.</p>"}<ul>${spec.approximations.map(note=>`<li>${escaped(note)}</li>`).join("")}</ul></div><div>${comparisons.filter(c=>c.id===spec.id&&c.theme==="Dark"&&c.width===1600).flatMap(c=>c.shots).map(shot=>`<img data-generated-image src="${shot}" alt="Generated ${escaped(spec.title)}">`).join("")}</div></div></section>`).join("")}</main><script>document.querySelectorAll("button[data-theme]").forEach(button=>button.addEventListener("click",()=>{const theme=button.dataset.theme;document.querySelectorAll("[data-generated-image]").forEach(img=>img.src=img.src.replace(/-(dark|light)-1600-/,"-"+theme+"-1600-"));document.querySelectorAll("button[data-theme]").forEach(control=>control.setAttribute("aria-pressed",String(control===button)))}))</script></html>`)
  await context?.close();await browser?.close();await environment?.close()
}
console.log(`${reports.length} reference-generation checks passed.`)
