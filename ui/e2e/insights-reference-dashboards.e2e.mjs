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
    if(widget.type==="stat") {
      assert.ok(await element.locator("[data-metric-value]").count(),`${widget.title} needs a real observed value`)
      if(widget.options?.showSparkline) {
        const margins=await element.evaluate(tile=>{const frame=tile.getBoundingClientRect(),plot=tile.querySelector('[data-stat-sparkline]').getBoundingClientRect(),reading=tile.querySelector('[data-metric-value]').getBoundingClientRect();return{left:plot.left-frame.left,right:frame.right-plot.right,bottom:frame.bottom-plot.bottom,reading:reading.left-frame.left}})
        assert.ok(margins.left<=2&&margins.right<=2&&margins.bottom<=2&&margins.reading>=12,`${widget.title}: sparkline reaches the panel edges without losing reading padding: ${JSON.stringify(margins)}`)
      }
    }
    else assert.ok(await element.locator("svg,table,[role=region]").count(),`${widget.title} needs a rendered chart or table`)
    if(widget.config?.seriesMode==="all") {
      const bank=element.locator("[data-gauge-bank-display]")
      assert.equal(await bank.locator("[data-gauge-series]").count(),widget.config.maxSeries,"Reference capacity panels must display every distinct series")
      const measurements=await bank.evaluate(node=>({height:node.clientHeight,content:node.scrollHeight}))
      const textBounds=await bank.evaluate(node=>{const tile=node.closest('[data-widget-id]').getBoundingClientRect(),bank=node.getBoundingClientRect();return [...node.querySelectorAll('[data-gauge-label], [data-gauge-value] > span')].map(text=>{const r=text.getBoundingClientRect();return{text:text.textContent,top:r.top,bottom:r.bottom,left:r.left,right:r.right,clipTop:Math.max(tile.top,bank.top),clipBottom:Math.min(tile.bottom,bank.bottom),clipLeft:Math.max(tile.left,bank.left),clipRight:Math.min(tile.right,bank.right),scroll:text.scrollWidth,client:text.clientWidth,height:text.scrollHeight,available:text.clientHeight}})})
      for(const text of textBounds) {
        if(page.viewportSize().width>=1200)assert.ok(text.top>=text.clipTop-.5&&text.bottom<=text.clipBottom+.5&&text.left>=text.clipLeft-.5&&text.right<=text.clipRight+.5,`${widget.title}: reading/label clipped ${JSON.stringify(text)}`)
        assert.ok(text.scroll<=text.client+1&&text.height<=text.available+1,`${widget.title}: fixture label/value must remain readable ${JSON.stringify(text)}`)
      }
      if(page.viewportSize().width>=1200)assert.ok(measurements.content<=measurements.height+1,`${widget.title}: all gauges must fit their panel without scrolling`)
      if(measurements.content>measurements.height+1) {
        await element.getByText(/^Scroll to see all gauges/).waitFor()
        assert.equal(await bank.getAttribute("tabindex"),"0","Overflowing gauges must be keyboard reachable")
        await bank.hover()
        await page.mouse.wheel(0,1000)
        await until(()=>bank.evaluate(node=>node.scrollTop>0),"Pointer scrolling must reach more gauges")
        await bank.focus()
        await bank.press("End")
        await until(()=>bank.evaluate(node=>{const bounds=node.getBoundingClientRect(),label=node.querySelector('[data-gauge-series]:last-child [data-gauge-label]').getBoundingClientRect();return label.top>=bounds.top&&label.bottom<=bounds.bottom+1}),"Keyboard scrolling must reveal the last gauge label")
        await page.screenshot({path:join(output,`${widget.id}-last-gauge-${page.viewportSize().width}.png`)})
        await bank.press("Home")
        await until(()=>bank.evaluate(node=>node.scrollTop===0),"Gauge bank must return to the first row")
      }
      const vertical=widget.config.orientation==="vertical" && widget.config.display!=="radial"
      if(widget.config.display!=="radial") {
        const tracks=await bank.locator('[data-gauge-display]').evaluateAll(nodes=>nodes.map(track=>{
          const bounds=track.getBoundingClientRect(),vertical=track.dataset.gaugeOrientation==="vertical"
          const item=track.closest('[data-gauge-series]'),label=item.querySelector('[data-gauge-label]').getBoundingClientRect(),reading=item.querySelector('[data-gauge-value]').getBoundingClientRect()
          const cells=[...track.querySelectorAll('[data-filled]')],rects=cells.map(cell=>cell.getBoundingClientRect())
          return {vertical,width:bounds.width,height:bounds.height,top:bounds.top,bottom:bounds.bottom,rendering:track.dataset.gaugeRendering,
            label:{left:label.left,right:label.right,top:label.top,bottom:label.bottom},reading:{left:reading.left,right:reading.right,top:reading.top,bottom:reading.bottom},left:bounds.left,right:bounds.right,
            cells:rects.map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height})),
            fill:cells.reduce((sum,cell,index)=>sum+(vertical?rects[index].height:rects[index].width)*Number(cell.style.getPropertyValue("--meter-fraction")),0),
            occupied:rects.reduce((sum,rect)=>sum+(vertical?rect.height:rect.width),0),
            progress:Number(track.dataset.gaugeProgress),expected:track.hasAttribute("aria-valuenow")?(Number(track.getAttribute("aria-valuenow"))-Number(track.getAttribute("aria-valuemin")))/(Number(track.getAttribute("aria-valuemax"))-Number(track.getAttribute("aria-valuemin"))):0}
        }))
        assert.ok(tracks.length>0,`${widget.title}: tracks must render`)
        for(const track of tracks) {
          assert.equal(track.vertical,vertical)
          assert.ok(Math.abs(track.progress-track.expected)<.005,`${widget.title}: responsive fill must preserve the observed proportion`)
          if(vertical) {
            assert.ok(track.height>track.width*1.5,`${widget.title}: vertical meters must have useful height`)
          } else {
            assert.ok(track.width>track.height,`${widget.title}: horizontal meters must have useful width`)
            assert.ok(track.label.right<=track.left+1 && track.right<=track.reading.left+1,`${widget.title}: label, bar and value must be aligned horizontally`)
          }
          if(track.rendering==="segmented") {
            assert.ok(track.cells.every(cell=>(vertical?cell.height:cell.width)>=3.95),`${widget.title}: separated cells must retain at least 4px of visible length`)
            assert.ok(Math.abs(track.fill/track.occupied-track.expected)<.005,`${widget.title}: segment fill preserves the observation`)
          }
        }
        if(vertical && page.viewportSize().width>=1200)assert.ok(Math.max(...tracks.map(track=>track.top))-Math.min(...tracks.map(track=>track.top))<1,`${widget.title}: all six host columns share one plot row`)
      }
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
      const coverage=await element.locator('svg').first().evaluate(svg=>{const r=svg.getBoundingClientRect(),cells=[...svg.querySelectorAll('[data-bucket-value]')].map(cell=>cell.getBoundingClientRect());return{height:r.height,filled:Math.max(...cells.map(cell=>cell.bottom))-Math.min(...cells.map(cell=>cell.top))}})
      assert.ok(coverage.filled>=coverage.height-30,"Histogram buckets use the available plot height")
      assert.ok(ticks.length>=2,"Heatmap retains a useful bucket axis")
      for(let index=1;index<ticks.length;index++)assert.ok(ticks[index].top>=ticks[index-1].bottom,"Heatmap bucket labels must not overlap")
    }
    if(widget.pluginId==="connection-map") {
      assert.equal(await element.locator("[data-geographic-land]").count(),1,"Map needs geographic context, not only coordinates")
      const plane=await element.locator('[data-map-plane]').evaluate(node=>{const r=node.getBoundingClientRect(),matrix=node.querySelector('svg').getScreenCTM();return{ratio:r.width/r.height,height:r.height,scaleX:matrix.a,scaleY:matrix.d}})
      assert.ok(Math.abs(plane.ratio-2)<.01 && Math.abs(plane.scaleX-plane.scaleY)<.001,`Map must preserve geographic proportions: ${JSON.stringify(plane)}`)
      assert.ok(plane.height>=80,"Map retains a useful world projection at this panel size")
    }
    if(widget.pluginId==="record-table" && widget.config.cellStyles?.length) {
      for(const style of widget.config.cellStyles) {
        const cells=element.locator(`[data-cell-display="${style.display}"]`)
        assert.ok(await cells.count()>0,`${widget.title}: ${style.display} cells render`)
        assert.ok((await cells.first().getAttribute('aria-label'))?.includes(':'),"Styled cells retain exact accessible readings")
        if(style.display==="bar") {
          const bars=await cells.locator('[data-bar-start]').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return{width:r.width,height:r.height,start:Number(node.dataset.barStart),end:Number(node.dataset.barEnd)}}))
          assert.ok(bars.every(bar=>bar.width>bar.height*2 && bar.start>=0 && bar.end<=1 && bar.end>=bar.start),`${widget.title}: in-cell bars have bounded horizontal geometry`)
        } else {
          const contrasts=await cells.evaluateAll(nodes=>{
            const channels=color=>{const values=color.match(/[\d.]+/g)?.map(Number)??[];return color.startsWith("color(srgb")?values.slice(0,3).map(value=>value*255):values.slice(0,3)}
            const luminance=color=>channels(color).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0)
            return nodes.map(node=>{
              let parent=node,background=""
              while(parent){background=getComputedStyle(parent).backgroundColor;if(background!=="transparent"&&background!=="rgba(0, 0, 0, 0)")break;parent=parent.parentElement}
              const foreground=getComputedStyle(node).color,a=luminance(foreground),b=luminance(background)
              return{foreground,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
            })
          })
          assert.ok(contrasts.every(entry=>entry.ratio>=4.5),`${widget.title}: colored numeric text remains readable in this theme: ${JSON.stringify(contrasts)}`)
        }
      }
      if(page.viewportSize().width<600) {
        const region=element.getByRole("region",{name:`${widget.title} records`,exact:true})
        const overflow=await region.evaluate(node=>node.scrollWidth>node.clientWidth+1)
        if(overflow) {
          assert.equal(await region.getAttribute("tabindex"),"0","Wide tables must be keyboard reachable")
          await region.hover()
          await page.mouse.wheel(3000,0)
          await until(()=>region.evaluate(node=>node.scrollLeft>0 && node.scrollLeft+node.clientWidth>=node.scrollWidth-1),"Pointer scrolling must reveal every table column")
          const before=await region.evaluate(node=>node.scrollLeft)
          await page.screenshot({path:join(output,`${widget.id}-last-column-390.png`)})
          await region.focus()
          await region.press("ArrowLeft")
          await until(()=>region.evaluate((node,before)=>node.scrollLeft<before,before),"Table columns must also respond to keyboard scrolling")
          await region.evaluate(node=>{node.scrollLeft=0})
        }
      }
    }
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
async function captureMobileComponents(board,theme) {
  const screenshots=[]
  for(const widget of board.widgets.filter(widget=>widget.options?.showSparkline || ["connection-map","threshold-gauge","distribution-heatmap","status-history","record-table"].includes(widget.pluginId))) {
    const element=tile(widget.id)
    await element.scrollIntoViewIfNeeded()
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const filename=`${widget.id}-${theme.toLowerCase()}-390-component.png`
    // Native viewport capture leaves IntersectionObserver visibility unchanged.
    await page.screenshot({path:join(output,filename)})
    screenshots.push(filename)
  }
  return screenshots
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
  await check("Table column scales preview, save and reload without changing saved queries",async()=>{
    const board=persisted.dashboards.find(item=>item.title==="Service overview")
    const widget=board.widgets.find(item=>item.id==="reference-service-overview-flow-readings")
    const original=await environment.api(`dashboards/${board.id}`)
    const originalQueries=(await snapshotStore()).queries
    const editScale=async maximum=>{
      await loadBoard(board,"Light")
      await page.getByRole("button",{name:"Edit dashboard",exact:true}).click()
      await tile(widget.id).getByRole("button",{name:`Edit ${widget.title}`,exact:true}).click()
      const editor=page.getByRole("region",{name:"Widget editor",exact:true})
      await editor.getByRole("tab",{name:"Query",exact:true}).click()
      await editor.getByRole("spinbutton",{name:"Column 1 maximum",exact:true}).fill(String(maximum))
      await until(async()=> (await tile(widget.id).locator('[data-cell-display="bar"]').first().getAttribute("aria-label"))?.includes(`to ${maximum}%`),"Column scale must preview in the widget before Apply")
      await editor.getByRole("button",{name:"Apply widget",exact:true}).click()
      await editor.getByRole("button",{name:"Close widget editor",exact:true}).click()
    }
    await editScale(200)
    assert.equal((await environment.api(`dashboards/${board.id}`)).etag,original.etag,"Draft changes must not persist before Save")
    await page.getByRole("button",{name:"Save dashboard",exact:true}).click()
    await page.getByText("All changes saved",{exact:true}).waitFor()
    await page.reload({waitUntil:"networkidle"})
    const changed=await environment.api(`dashboards/${board.id}`)
    const savedWidget=changed.document.widgets.find(item=>item.id===widget.id)
    assert.equal(savedWidget.config.cellStyles[0].max,200)
    assert.deepEqual(savedWidget.queryRef,widget.queryRef)
    assert.notEqual(changed.etag,original.etag)
    await editScale(100)
    await page.getByRole("button",{name:"Save dashboard",exact:true}).click()
    await page.getByText("All changes saved",{exact:true}).waitFor()
    const restored=await environment.api(`dashboards/${board.id}`)
    assert.deepEqual(restored.document.widgets.find(item=>item.id===widget.id).config,widget.config)
    assert.deepEqual((await snapshotStore()).queries,originalQueries,"Cell presentation must not alter saved query documents")
    assert.ok(writes.some(write=>write.path===`/api/insights/dashboards/${board.id}`&&write.conditional===original.etag),"Saving uses the current dashboard ETag")
    return{previewBeforeSave:true,maximum:200,restoredMaximum:100,savedQueryUnchanged:true,etagProtected:true}
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
  await check("Saved-query library loading stays a loading state until definitions arrive",async()=>{
    let release, blocked=false
    const pending=new Promise(resolve=>{release=resolve})
    const pattern="**/api/insights/saved-queries"
    const hold=async route=>{blocked=true;await pending;await route.fallback()}
    await page.route(pattern,hold)
    try {
      const board=persisted.dashboards.find(item=>item.title==="Service overview")
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${board.id}`,{waitUntil:"domcontentloaded"})
      await page.getByRole("heading",{name:board.title,exact:true}).waitFor()
      await until(()=>blocked,"Saved-query list must be held for the loading-state check")
      await page.getByRole("status",{name:"Loading widget",exact:true}).first().waitFor()
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
      assert.deepEqual(await page.getByRole("alert").allTextContents(),[],"Loading saved definitions must not flash a query failure")
      release()
      await renderEveryPanel(board)
      return{delayedLibrary:true,loadingBeforeDefinitions:true,queriesRenderAfterRelease:true}
    } finally {release();await page.unroute(pattern,hold)}
  })
  await page.setViewportSize({width:390,height:844})
  for(const reference of referenceDashboards)for(const theme of ["Dark","Light"])await check(`${reference.title}: ${theme} generated dashboard remains usable on mobile`,async()=>{
    const board=persisted.dashboards.find(item=>item.title===reference.title)
    await loadBoard(board,theme);await renderEveryPanel(board)
    const shape=await geometry(board,false)
    await captureBoard(reference,board,theme)
    const componentScreenshots=await captureMobileComponents(board,theme)
    assert.deepEqual((await environment.api(`dashboards/${board.id}`)).document.widgets.map(w=>w.layout),board.widgets.map(w=>w.layout),"Responsive reflow must not mutate the saved layout")
    return{panels:board.widgets.length,shape,componentScreenshots}
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
