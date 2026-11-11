// MCP-authored documents -> authenticated real Insights UI -> isolated Chromium
// worker. Kubernetes and telemetry are deterministic fixtures, never live claims.
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {randomBytes} from "node:crypto"
import {once} from "node:events"
import {createServer,request as httpRequest} from "node:http"
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join,resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {chromium} from "playwright"
import {createRenderServer,closeRenderBrowser} from "../render-worker.mjs"
import {dashboardProbe} from "../dashboard-probe.mjs"

const repository=resolve(fileURLToPath(new URL("../../",import.meta.url)))
const temporary=await mkdtemp(join(tmpdir(),"paprika-render-e2e-"))
const output=join(repository,"artifacts/insights/render-worker")
const binary=join(temporary,"observe-e2e"),ready=join(temporary,"ready.json")
const secret=randomBytes(48).toString("base64")
let fixture,processHandle,worker,workerURL,rpcId=0,outputLog=""

async function until(predicate,message) {
  const deadline=Date.now()+30_000
  while(Date.now()<deadline) {
    if(await predicate())return
    await new Promise(resolve=>setTimeout(resolve,40))
  }
  throw Error(message)
}
async function tool(name,args,token=fixture.mcpWriteToken) {
  const id=++rpcId
  const response=await fetch(fixture.mcpURL,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",Authorization:"Bearer "+token,"MCP-Protocol-Version":"2025-03-26"},body:JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}}),signal:AbortSignal.timeout(30_000)})
  assert.equal(response.status,200)
  const text=await response.text()
  const value=response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6))).find(item=>item.id===id)
    : JSON.parse(text)
  assert.equal(value.error,undefined,JSON.stringify(value.error))
  assert.notEqual(value.result.isError,true,JSON.stringify(value.result.content))
  return value.result.structuredContent??JSON.parse(value.result.content.find(item=>item.type==="text").text)
}
function render(args,etag,token=fixture.viewerToken) {
  return fetch(workerURL+"/render",{method:"POST",headers:{Authorization:"Bearer "+token,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":etag,"Content-Type":"application/json"},body:JSON.stringify(args),signal:AbortSignal.timeout(25_000)})
}

async function verifyResponseIsolation() {
  const received=[]
  const sink=createServer((req,res)=>{received.push(req.headers);res.writeHead(200).end("unexpected")})
  const token="redirect-isolation-test-token"
  let sourceAuthorization,redirectWorker
  const revision='"'+"0".repeat(64)+'"'
  let conditionalReads=0,conditionalMatched=false,queryErrorRead=false
  const sourceRequests=[]
  const source=createServer((req,res)=>{
    sourceRequests.push({method:req.method,path:req.url})
    if(req.url==="/api/insights/dashboards/redirect-test") {
      sourceAuthorization=req.headers.authorization
      res.writeHead(302,{Location:"http://127.0.0.1:"+sink.address().port+"/denied"}).end()
    } else if(req.url==="/api/insights/dashboards/conditional-test") {
      conditionalReads++
      conditionalMatched=req.headers["if-none-match"]===revision && req.headers.authorization==="Bearer "+token
      res.writeHead(conditionalReads===1?200:304,{"Content-Type":"application/json","Cache-Control":"no-store",ETag:revision}).end(conditionalReads===1?'{"id":"conditional-test"}':undefined)
    } else if(req.url==="/api/insights/dashboards/query-error-test") {
      res.writeHead(200,{"Content-Type":"application/json",ETag:revision}).end('{"id":"query-error-test"}')
    } else if(req.url==="/api/insights/query" && req.method==="POST") {
      queryErrorRead=req.headers.authorization==="Bearer "+token
      res.writeHead(200,{"Content-Type":"application/json"}).end('{"error":"fixture provider query failed"}')
    } else {
      const id=new URL(req.url,"http://fixture").searchParams.get("dashboard")
      const load=id==="conditional-test"
        ? `fetch("/api/insights/dashboards/conditional-test").then(()=>fetch("/api/insights/dashboards/conditional-test",{headers:{"If-None-Match":${JSON.stringify(revision)}}})).then(response=>{if(response.status!==304)throw Error("conditional read did not return304")})`
        : id==="query-error-test"
        ? 'fetch("/api/insights/dashboards/query-error-test").then(()=>fetch("/api/insights/query",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).catch(()=>{})'
        : 'fetch("/api/insights/dashboards/redirect-test").catch(()=>{})'
      res.writeHead(200,{"Content-Type":"text/html"}).end('<main data-testid="dashboard-canvas"><div data-widget-id="response"><span aria-busy="true">Response policy fixture</span></div></main><script>'+load+'.finally(()=>document.querySelector("[aria-busy]").removeAttribute("aria-busy"))</script>')
    }
  })
  try {
    await new Promise(resolve=>sink.listen(0,"127.0.0.1",resolve))
    await new Promise(resolve=>source.listen(0,"127.0.0.1",resolve))
    redirectWorker=createRenderServer({secret,uiOrigin:"http://127.0.0.1:"+source.address().port})
    await new Promise(resolve=>redirectWorker.listen(0,"127.0.0.1",resolve))
    const capture=id=>fetch("http://127.0.0.1:"+redirectWorker.address().port+"/render",{
      method:"POST",headers:{Authorization:"Bearer "+token,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":revision,"Content-Type":"application/json"},
      body:JSON.stringify({id}),signal:AbortSignal.timeout(25_000),
    })
    const response=await capture("redirect-test")
    assert.equal(response.status,422,"a redirected dashboard request must fail rendering: "+JSON.stringify({sourceRequests,credentialed:sourceAuthorization==="Bearer "+token,sinkRequests:received.length}))
    assert.equal(sourceAuthorization,"Bearer "+token,"test must exercise credentialed Insights fetch")
    assert.deepEqual(received,[],"a redirect must never reach an unapproved destination or forward its token")
    console.log("PASS browser redirect isolation: credentialed request never reaches denied sink")
    const conditional=await capture("conditional-test")
    assert.equal(conditional.status,200,"normal304 document revalidation must remain renderable")
    assert.equal(conditional.headers.get("x-paprika-dashboard-etag"),revision)
    assert.equal(conditionalReads,2)
    assert.equal(conditionalMatched,true,"revalidation must retain its conditional header and scoped credential")
    await conditional.arrayBuffer()
    console.log("PASS browser conditional document read:304 retains the observed revision")
    const queryError=await capture("query-error-test")
    assert.equal(queryError.status,422,"HTTP200 provider error envelopes must fail before producing an image")
    assert.equal(queryErrorRead,true,"the failing query must use the scoped credential")
    console.log("PASS browser provider error envelope is rejected despite HTTP200")
  } finally {
    for(const server of [redirectWorker,source,sink])if(server?.listening) {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    }
  }
}

function fixtureProxy(queryRequest) {
  return createServer((req,res)=>{
    if(req.method==="POST" && req.url==="/api/insights/query" && queryRequest(req,res))return
    const target=new URL(req.url,fixture.baseURL)
    const upstream=httpRequest(target,{method:req.method,headers:{...req.headers,host:target.host}},response=>{
      res.writeHead(response.statusCode,response.headers)
      response.pipe(res)
    })
    upstream.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    req.on("aborted",()=>upstream.destroy())
    res.on("close",()=>upstream.destroy())
    req.pipe(upstream)
  })
}

async function verifyCanonicalCapacityRetry(dashboard) {
  const created=await tool("create_dashboard",{document:{...dashboard,id:"mcp-render-capacity",widgets:[dashboard.widgets[1]]}})
  let mode="once",attempts=0,rejections=0,retryWorker
  const proxy=fixtureProxy((req,res)=>{
    attempts++
    if(mode!=="always" && rejections!==0)return false
    rejections++
    req.resume()
    res.writeHead(429,{"Content-Type":"application/json","Retry-After":"1"}).end('{"error":"fixture query capacity is exhausted; retry shortly"}')
    return true
  })
  try {
    await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve))
    retryWorker=createRenderServer({secret,uiOrigin:"http://127.0.0.1:"+proxy.address().port})
    await new Promise(resolve=>retryWorker.listen(0,"127.0.0.1",resolve))
    const capture=()=>fetch("http://127.0.0.1:"+retryWorker.address().port+"/render",{
      method:"POST",headers:{Authorization:"Bearer "+fixture.viewerToken,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":created.etag,"Content-Type":"application/json"},
      body:JSON.stringify({id:created.document.id,width:1512}),signal:AbortSignal.timeout(25_000),
    })
    const recovered=await capture()
    assert.equal(recovered.status,200,"the canonical UI must recover from one query429 with Retry-After")
    assert.equal(recovered.headers.get("x-paprika-dashboard-etag"),created.etag)
    assert.equal(recovered.headers.get("content-type"),"image/png")
    assert.equal(rejections,1)
    assert.ok(attempts>=2,"the retry must reach the same canonical read-only query endpoint")
    await recovered.arrayBuffer()
    console.log("PASS canonical UI query retries429 with Retry-After and produces an exact-revision PNG")

    mode="always";attempts=0;rejections=0
    const rejected=await capture()
    assert.ok([422,504].includes(rejected.status),"persistent429 must end in a widget error or the existing deadline")
    assert.ok(attempts>=2,"persistent rate limits must exercise the UI's bounded retry path")
    assert.notEqual(rejected.headers.get("content-type"),"image/png")
    await rejected.arrayBuffer()
    console.log("PASS persistent query429 cannot produce a misleading screenshot")
  } finally {
    for(const server of [retryWorker,proxy])if(server?.listening) {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    }
  }
}

async function verifyDenseDashboard(dashboard) {
  const document={...dashboard,id:"mcp-render-sixteen-fixture",title:"Synthetic16-widget render fixture",
    description:"Deterministic test data with16 distinct fixture expressions; never a production telemetry claim.",
    widgets:Array.from({length:16},(_,i)=>({...dashboard.widgets[1],id:"fixture-"+(i+1),title:"Synthetic signal "+(i+1),
      query:dashboard.widgets[1].query+" + "+i,layout:{x:i%4*3,y:Math.floor(i/4)*4,w:3,h:4}})),
  }
  const expectedQueries=document.widgets.map(widget=>widget.query).sort()
  assert.equal(new Set(expectedQueries).size,16)
  const created=await tool("create_dashboard",{document})
  const signals=await tool("query_dashboard",{id:document.id,history_points:0,max_series:1},fixture.mcpViewerToken)
  assert.equal(signals.state,"ok")
  assert.equal(signals.queryCount.executed,16)
  assert.equal(signals.queryCount.deduplicated,0)
  const observedQueries=new Set(),evidence=[]
  let denseWorker
  const proxy=fixtureProxy(req=>{
    const chunks=[]
    req.on("data",chunk=>chunks.push(chunk))
    req.on("end",()=>observedQueries.add(JSON.parse(Buffer.concat(chunks).toString("utf8")).query))
    return false
  })
  try {
    await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve))
    denseWorker=createRenderServer({secret,uiOrigin:"http://127.0.0.1:"+proxy.address().port})
    await new Promise(resolve=>denseWorker.listen(0,"127.0.0.1",resolve))
    for(const width of [1512,390]) {
      observedQueries.clear()
      const response=await fetch("http://127.0.0.1:"+denseWorker.address().port+"/render",{
        method:"POST",headers:{Authorization:"Bearer "+fixture.viewerToken,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":created.etag,"Content-Type":"application/json"},
        body:JSON.stringify({id:document.id,width,theme:"dark"}),signal:AbortSignal.timeout(25_000),
      })
      assert.equal(response.status,200,`synthetic16-widget render failed at${width}px: `+response.headers.get("x-paprika-render-failure"))
      assert.equal(response.headers.get("x-paprika-dashboard-etag"),created.etag)
      assert.equal(response.headers.get("content-type"),"image/png")
      const png=Buffer.from(await response.arrayBuffer())
      assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
      assert.equal(png.readUInt32BE(16),width)
      assert.ok(png.readUInt32BE(20)>=980 && png.readUInt32BE(20)<=12000 && png.length<=(4<<20))
      assert.deepEqual([...observedQueries].sort(),expectedQueries,"every distinct fixture query must reach the canonical HTTP endpoint")
      await writeFile(join(output,`synthetic-sixteen-dark-${width}.png`),png)
      evidence.push({width,height:png.readUInt32BE(20),widgets:16,queries:observedQueries.size,etag:created.etag})
      console.log(`PASS synthetic16-widget dashboard at${width}px renders16 distinct queries with exact revision`)
    }
    const after=await tool("get_dashboard",{id:document.id},fixture.mcpViewerToken)
    assert.equal(after.etag,created.etag)
    assert.deepEqual(after.document,created.document,"dense browser captures must not mutate their saved document")
    return evidence
  } finally {
    for(const server of [denseWorker,proxy])if(server?.listening) {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    }
  }
}

// The JSON envelope is what the gateway asks for: visual findings beside the PNG,
// or findings alone with checks_only.
async function renderChecks(args,etag,token=fixture.viewerToken) {
  const response=await fetch(workerURL+"/render",{method:"POST",headers:{Authorization:"Bearer "+token,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":etag,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(args),signal:AbortSignal.timeout(25_000)})
  assert.equal(response.status,200,`visual checks ${JSON.stringify(args)} failed: ${response.headers.get("x-paprika-render-failure")}`)
  assert.equal(response.headers.get("content-type"),"application/json")
  assert.equal(response.headers.get("x-paprika-dashboard-etag"),etag)
  return response.json()
}
const summarise=report=>report.issues.map(issue=>`${issue.severity.replace("SEVERITY_","")} ${issue.ruleId} ${issue.widgetId||"(page)"}`)

// Document and listing reads are the render's source of truth. When one fails, the
// probe would judge a screen that never loaded its data, so the render fails closed
// even with checks. A failed query is different: the UI shows the error on its own
// tile, so the probe attributes it to that widget and the render still returns.
function failingProxy(matches,status) {
  return createServer((req,res)=>{
    if(matches(req)) {
      req.resume()
      res.writeHead(status,{"Content-Type":"application/json"}).end('{"error":"fixture read failed"}')
      return
    }
    const target=new URL(req.url,fixture.baseURL)
    const upstream=httpRequest(target,{method:req.method,headers:{...req.headers,host:target.host}},response=>{
      res.writeHead(response.statusCode,response.headers)
      response.pipe(res)
    })
    upstream.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end()})
    res.on("close",()=>upstream.destroy())
    req.pipe(upstream)
  })
}
async function renderThroughFailingProxy(dashboard,matches,status,{checks=true}={}) {
  let proxy,worker
  try {
    proxy=failingProxy(matches,status)
    await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve))
    worker=createRenderServer({secret,uiOrigin:"http://127.0.0.1:"+proxy.address().port})
    await new Promise(resolve=>worker.listen(0,"127.0.0.1",resolve))
    const headers={Authorization:"Bearer "+fixture.viewerToken,"X-Paprika-Render-Secret":secret,"X-Paprika-Dashboard-ETag":dashboard.etag,"Content-Type":"application/json"}
    if(checks)headers.Accept="application/json"
    const response=await fetch("http://127.0.0.1:"+worker.address().port+"/render",{method:"POST",headers,body:JSON.stringify({id:dashboard.document.id,...(checks?{checks_only:true}:{})}),signal:AbortSignal.timeout(25_000)})
    const body=response.status===200&&checks?await response.json():null
    if(!body)await response.arrayBuffer()
    return {response,body}
  } finally {
    for(const server of [worker,proxy])if(server?.listening) {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    }
  }
}
async function verifyChecksFailClosed(dashboard) {
  const created=await tool("create_dashboard",{document:{...dashboard,id:"mcp-render-checks-fail",widgets:[dashboard.widgets[1]]}})
  const document={document:created.document,etag:created.etag}
  const listing=await renderThroughFailingProxy(document,req=>req.method==="GET"&&req.url.startsWith("/api/insights/providers"),500)
  assert.equal(listing.response.status,422,"a failed listing read must fail the render even with checks")
  assert.equal(listing.response.headers.get("x-paprika-render-failure"),"insights_http")
  console.log("PASS checks fail closed when a listing read fails")
  const query=await renderThroughFailingProxy(document,req=>req.method==="POST"&&req.url==="/api/insights/query",500)
  assert.equal(query.response.status,200,"a failed query is attributed by the probe, not treated as a failed render")
  const attributed=query.body.checks.issues.filter(issue=>issue.widgetId===dashboard.widgets[1].id&&issue.ruleId==="visual.widget-error")
  assert.equal(attributed.length,1,`the failed query is a widget error on its own widget: ${JSON.stringify(query.body.checks.issues)}`)
  assert.equal(attributed[0].severity,"SEVERITY_ERROR")
  console.log("PASS a failed query is a visual.widget-error on its own widget, and the render still returns")
  const legacy=await renderThroughFailingProxy(document,req=>req.method==="POST"&&req.url==="/api/insights/query",500,{checks:false})
  assert.equal(legacy.response.status,422,"a PNG-only caller still fails closed on a failed query")
  assert.equal(legacy.response.headers.get("x-paprika-render-failure"),"insights_http")
  console.log("PASS PNG-only renders keep failing closed on a failed query")
}

// Fixture dashboards trigger one visual condition each, on a widget that is
// otherwise healthy. ok-stat and plot-ok must stay clean in every case.
function visualWidget(id,providerId,query,extras) {
  return {id,title:id,type:"stat",providerId,query,unit:"req/s",color:"#557EAA",...extras}
}
async function verifyVisualChecks(providerId) {
  const query='sum(rate(http_requests_total{service="api-gateway"}[5m]))'
  const healthy=[
    visualWidget("ok-stat",providerId,query,{options:{decimals:2,showSparkline:true,sparklinePlacement:"side",showTooltip:true},layout:{x:6,y:0,w:4,h:2}}),
    {id:"plot-ok",title:"Plot ok",type:"timeseries",providerId,query,unit:"req/s",color:"#557EAA",options:{display:"area",showTooltip:true,showGrid:true,showLegend:false},layout:{x:4,y:2,w:8,h:5}},
  ]
  const clean=await tool("create_dashboard",{document:{schemaVersion:1,id:"mcp-render-visual-clean",title:"Visual checks clean fixture",description:"Deterministic telemetry; no visual defects expected",timeRange:"1h",refreshInterval:0,widgets:healthy}})
  const defects=await tool("create_dashboard",{document:{schemaVersion:1,id:"mcp-render-visual-defects",title:"Visual checks defect fixture",description:"Deterministic telemetry; one visual defect per widget",timeRange:"1h",refreshInterval:0,widgets:[
    ...healthy,
    visualWidget("scroll-stat",providerId,query,{description:"Live telemetry through the shared pre-existing saved query for the whole regional fleet. ".repeat(3),options:{decimals:2,showSparkline:true,sparklinePlacement:"side",showTooltip:true,showStatBar:false},layout:{x:0,y:0,w:4,h:1}}),
    visualWidget("clip-stat",providerId,query,{unit:"req per second long unit",options:{decimals:2,showSparkline:true,sparklinePlacement:"side",showTooltip:true},layout:{x:4,y:0,w:2,h:2}}),
    visualWidget("missing-provider",providerId,query,{providerId:"missing-provider-fixture",options:{decimals:2},layout:{x:0,y:2,w:4,h:2}}),
    {id:"plot-range",title:"Plot out of range",type:"timeseries",providerId,query,unit:"req/s",color:"#557EAA",options:{display:"line",min:1000,max:2000,showTooltip:true,showGrid:true,showLegend:true},layout:{x:0,y:6,w:4,h:5}},
    {id:"table-short",title:"Table short",type:"table",providerId,query,unit:"req/s",color:"#557EAA",options:{},layout:{x:0,y:11,w:4,h:2}},
  ]}})
  const cleanReports={}
  for (const width of [1512,390]) {
    const report=await renderChecks({id:clean.document.id,width,theme:"dark",checks_only:true},clean.etag)
    assert.deepEqual(report.checks.issues,[],`clean dashboard at ${width}px must report no visual findings: ${summarise(report.checks).join("; ")}`)
    assert.equal(report.checks.total,0)
    assert.ok(Number.isInteger(report.timings.readyMs)&&Number.isInteger(report.timings.probeMs)&&Number.isInteger(report.timings.renderMs))
    cleanReports[width]=report.timings
  }
  const report=await renderChecks({id:defects.document.id,width:1512,theme:"dark",checks_only:true},defects.etag)
  const found=(widget,rule)=>report.checks.issues.filter(issue=>issue.widgetId===widget&&issue.ruleId===rule)
  const severityOf=name=>report.checks.issues.filter(issue=>issue.severity===name).length
  assert.equal(report.checks.errorCount,severityOf("SEVERITY_ERROR"),"the error count matches the listed errors when nothing is truncated")
  assert.equal(report.checks.warningCount,severityOf("SEVERITY_WARNING"))
  assert.equal(report.checks.truncated,false)
  assert.equal(found("scroll-stat","visual.clipped-text").length,1,`stat value cut off: ${summarise(report.checks).join("; ")}`)
  assert.equal(found("scroll-stat","visual.clipped-text")[0].severity,"SEVERITY_ERROR")
  assert.equal(found("scroll-stat","visual.internal-scroll").length,1,"a collapsed stat body is a scroller")
  assert.equal(found("clip-stat","visual.clipped-text")[0]?.severity,"SEVERITY_ERROR","a unit cut at the tile edge")
  assert.equal(found("missing-provider","visual.widget-error")[0]?.severity,"SEVERITY_ERROR","an unbound provider is a widget error with its id")
  assert.equal(found("plot-range","visual.empty-plot")[0]?.severity,"SEVERITY_WARNING","data scaled outside the plot draws nothing")
  // A table body is a focusable, named region (role=region, aria-label), so its scrolling is designed and not a finding.
  assert.equal(found("table-short","visual.internal-scroll").length,0,"a named table region is an intentional scroll region")
  for (const widget of ["ok-stat","plot-ok"]) assert.deepEqual(report.checks.issues.filter(issue=>issue.widgetId===widget),[],`${widget} is healthy`)
  assert.ok(report.checks.issues.every(issue=>issue.source===undefined||issue.source==="SOURCE_VISUAL"),"visual findings carry the visual source")
  assert.ok(report.checks.issues.every(issue=>issue.ruleId.startsWith("visual.")))
  assert.equal("png" in report,false,"checks_only never returns an image")
  // Image and findings together: the same render returns the PNG and the report.
  const both=await renderChecks({id:defects.document.id,width:390,theme:"dark"},defects.etag)
  const png=Buffer.from(both.png,"base64")
  assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
  assert.equal(png.readUInt32BE(16),390)
  assert.ok(both.checks.issues.some(issue=>issue.ruleId==="visual.widget-error"&&issue.widgetId==="missing-provider"),"a narrow render still reports the widget error")
  assert.ok(!both.checks.issues.some(issue=>["ok-stat","plot-ok"].includes(issue.widgetId)))
  const after=await tool("get_dashboard",{id:defects.document.id},fixture.mcpViewerToken)
  assert.equal(after.etag,defects.etag,"visual checks must not mutate the saved document")
  console.log(`PASS visual checks: clean fixture has no findings at 1512 and 390; defect fixture reports ${report.checks.total} findings with ids, severities and widgets`)
  return {clean:cleanReports,defects:summarise(report.checks),defectTimings:report.timings}
}

// Real layout, synthetic markup: each rule has a positive and a negative page, so
// the rule conditions are exercised without the Insights stack.
const detailRows="<p style=\"margin:0\">Row of text</p>".repeat(8)
const probeCases=[
  {name:"page overflow",width:390,positive:'<div data-widget-id="wide" style="width:700px;height:30px">wide</div>',negative:'<div data-widget-id="wide" style="width:300px;height:30px">fits</div>',rule:"visual.page-overflow@:SEVERITY_ERROR"},
  {name:"metric value clipped",width:390,positive:'<article data-widget-id="kpi" style="width:150px;height:60px;overflow:hidden"><div data-metric-value="1" style="white-space:nowrap;font-size:28px">101.23 <span style="font-size:14px">req per second long unit</span></div></article>',negative:'<article data-widget-id="kpi" style="width:400px;height:60px;overflow:hidden"><div data-metric-value="1" style="white-space:nowrap;font-size:28px">101.23 <span style="font-size:14px">req/s</span></div></article>',rule:"visual.clipped-text@kpi:SEVERITY_ERROR"},
  {name:"description clipped",width:390,positive:'<article data-widget-id="note" style="width:150px;height:60px;overflow:hidden"><p style="margin:0;white-space:nowrap">A long description that runs out of the card entirely.</p></article>',negative:'<article data-widget-id="note" style="width:400px;height:60px;overflow:hidden"><p style="margin:0">Short text.</p></article>',rule:"visual.clipped-text@note:SEVERITY_WARNING"},
  {name:"title ellipsis without an ellipsis",width:390,positive:'<article data-widget-id="title" style="width:120px"><h3 style="margin:0;overflow:hidden;white-space:nowrap">A title that is much too long for its box</h3></article>',negative:'<article data-widget-id="title" style="width:120px"><h3 style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A title that is much too long for its box</h3></article>',rule:"visual.clipped-text@title:SEVERITY_WARNING"},
  {name:"body scrolls",width:390,positive:'<article data-widget-id="rows" style="width:300px;height:60px"><div style="height:60px;overflow-y:auto">'+"<p style=\"margin:0\">Row of text</p>".repeat(8)+'</div></article>',negative:'<article data-widget-id="rows" style="width:300px;height:60px"><div style="height:60px;overflow-y:auto"><p style="margin:0">Row</p></div></article>',rule:"visual.internal-scroll@rows:SEVERITY_WARNING"},
  {name:"plot has data but draws nothing",width:390,positive:'<div data-widget-id="flat" data-series-count="1" style="width:300px"><svg role="img" width="300" height="150"><line x1="0" y1="140" x2="300" y2="140" stroke="#999"/></svg></div>',negative:'<div data-widget-id="flat" data-series-count="1" style="width:300px"><svg role="img" width="300" height="150"><line x1="0" y1="140" x2="300" y2="140" stroke="#999"/><path d="M0,100 L300,50" stroke="#557EAA" stroke-width="1.8" fill="none"/></svg></div>',rule:"visual.empty-plot@flat:SEVERITY_WARNING"},
  {name:"widget error state",width:390,positive:'<article data-widget-id="broken" style="width:300px"><div role="alert" style="height:30px">Query failed</div></article>',negative:'<article data-widget-id="broken" style="width:300px"><p>Fine</p></article>',rule:"visual.widget-error@broken:SEVERITY_ERROR"},
  // Closed details: Chromium lays out a closed body, but it is not visible, so it is not a scroller.
  {name:"closed details body is not visible",width:390,positive:'<article data-widget-id="closed" style="width:300px"><details open><summary>More</summary><div style="height:40px;overflow-y:auto">'+detailRows+'</div></details></article>',negative:'<article data-widget-id="closed" style="width:300px"><details><summary>More</summary><div style="height:40px;overflow-y:auto">'+detailRows+'</div></details></article>',rule:"visual.internal-scroll@closed:SEVERITY_WARNING"},
  // A focusable, named region scrolls by design (records, traces, events). An unnamed body is a defect.
  {name:"named scroll region is intentional",width:390,positive:'<article data-widget-id="records" style="width:300px;height:60px"><div style="height:60px;overflow-y:auto">'+detailRows+'</div></article>',negative:'<article data-widget-id="records" style="width:300px;height:60px"><div role="region" tabindex="0" aria-label="Recent records" style="height:60px;overflow-y:auto">'+detailRows+'</div></article>',rule:"visual.internal-scroll@records:SEVERITY_WARNING"},
  // Line-clamped text is truncated on purpose, like text-overflow ellipsis.
  {name:"line-clamped description is intentional",width:390,positive:'<article data-widget-id="clamp" style="width:150px"><p style="margin:0;height:40px;overflow:hidden">A description that wraps over several lines and runs past the height of its box.</p></article>',negative:'<article data-widget-id="clamp" style="width:150px"><p style="margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">A description that wraps over several lines and runs past the height of its box.</p></article>',rule:"visual.clipped-text@clamp:SEVERITY_WARNING"},
  // An all-zero bar chart draws nothing because its values are zero, not because the plot is broken.
  {name:"all-zero bars are not an empty plot",width:390,positive:'<div data-widget-id="bars" data-series-count="1" style="width:300px"><svg role="img" width="300" height="150"></svg><span data-legend-value="5">5</span></div>',negative:'<div data-widget-id="bars" data-series-count="1" style="width:300px"><svg role="img" width="300" height="150"></svg><span data-legend-value="0">0</span></div>',rule:"visual.empty-plot@bars:SEVERITY_WARNING"},
  // A time series with its legend hidden still reports its series on the chart root.
  {name:"time series without a legend is checked",width:390,positive:'<div data-widget-id="noleg" data-series-count="2" style="width:300px"><svg role="img" width="300" height="150"><line x1="0" y1="140" x2="300" y2="140" stroke="#999"/></svg></div>',negative:'<div data-widget-id="noleg" data-series-count="2" style="width:300px"><svg role="img" width="300" height="150"><path d="M0,100 L300,50" stroke="#557EAA" stroke-width="1.8" fill="none"/></svg></div>',rule:"visual.empty-plot@noleg:SEVERITY_WARNING"},
]
async function verifyProbeRuleMatrix() {
  const browser=await chromium.launch({headless:true,args:["--no-sandbox"]})
  const results=[]
  try {
    for (const probeCase of probeCases) {
      for (const [kind,markup] of [["positive",probeCase.positive],["negative",probeCase.negative]]) {
        const context=await browser.newContext({viewport:{width:probeCase.width,height:800}})
        const page=await context.newPage()
        try {
          await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;font:14px sans-serif}</style></head><body>'+markup+'</body></html>')
          const probed=await page.evaluate(dashboardProbe,{})
          const ids=probed.findings.map(f=>f.ruleId+"@"+f.widgetId+":"+f.severity)
          if (kind==="positive") assert.ok(ids.includes(probeCase.rule),`${probeCase.name} must report ${probeCase.rule}: ${JSON.stringify(ids)}`)
          else assert.deepEqual(ids.filter(id=>id.startsWith(probeCase.rule.split("@")[0])),[],`${probeCase.name} must not report ${probeCase.rule.split("@")[0]}: ${JSON.stringify(ids)}`)
          results.push({rule:probeCase.rule.split("@")[0],kind,ok:true})
        } finally { await context.close() }
      }
    }
  } finally { await browser.close() }
  assert.equal(new Set(results.map(r=>r.rule)).size,5,"every visual rule has a matrix case")
  console.log(`PASS visual probe rule matrix: ${results.length} real-layout cases, a positive and a negative for each of 5 rules`)
  return results
}

try {
  await mkdir(output,{recursive:true})
  await verifyResponseIsolation()
  const build=spawn("go",["build","-o",binary,"./hack/insights-observe-e2e"],{cwd:repository,stdio:"inherit"})
  assert.equal((await once(build,"exit"))[0],0,"render fixture must build")
  // Exercise the same compiled static UI served in production, including its
  // asset paths. The surrounding browser suite's Next dev URL is irrelevant.
  processHandle=spawn(binary,["--ready-file="+ready,"--ui-dir="+join(repository,"ui/out"),"--data-dir="+join(temporary,"data")],{cwd:repository,stdio:["ignore","pipe","pipe"]})
  processHandle.stdout.on("data",data=>{outputLog+=data})
  processHandle.stderr.on("data",data=>{outputLog+=data})
  await until(async()=>{
    if(processHandle.exitCode!==null)throw Error("fixture exited: "+outputLog)
    try{fixture=JSON.parse(await readFile(ready,"utf8"));return true}catch{return false}
  },"render fixture did not start")
  worker=createRenderServer({secret,uiOrigin:fixture.baseURL})
  await new Promise(resolve=>worker.listen(0,"127.0.0.1",resolve))
  workerURL="http://127.0.0.1:"+worker.address().port
  const providers=(await tool("list_insights_providers",{},fixture.mcpViewerToken)).providers
  const provider=providers.find(item=>item.providerRef===fixture.providerRef)
  assert.ok(provider)
  const query='sum(rate(http_requests_total{service="api-gateway"}[5m]))'
  const dashboard={schemaVersion:1,id:"mcp-render-review",title:"MCP visual review",description:"Deterministic browser test telemetry",timeRange:"1h",refreshInterval:0,widgets:[
    {id:"rate",title:"Request rate",type:"stat",providerId:provider.id,query,unit:"req/s",color:"#557EAA",options:{decimals:2,showSparkline:true,sparklinePlacement:"side",showTooltip:true},layout:{x:0,y:0,w:4,h:2}},
    {id:"traffic",title:"Request throughput",type:"timeseries",providerId:provider.id,query,unit:"req/s",color:"#557EAA",options:{display:"area",showTooltip:true,showGrid:true,showLegend:false},layout:{x:0,y:2,w:12,h:5}},
  ]}
  const created=await tool("create_dashboard",{document:dashboard})
  const data=await tool("query_dashboard",{id:dashboard.id,max_series:1},fixture.mcpViewerToken)
  assert.equal(data.state,"ok")
  const evidence=[]
  for(const theme of ["dark","light"])for(const width of [1512,390]) {
    const response=await render({id:dashboard.id,width,theme},created.etag)
    assert.equal(response.status,200,`render ${theme}/${width} failed`)
    assert.equal(response.headers.get("x-paprika-dashboard-etag"),created.etag)
    assert.equal(response.headers.get("content-type"),"image/png")
    const png=Buffer.from(await response.arrayBuffer())
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10])
    assert.equal(png.readUInt32BE(16),width)
    assert.ok(png.readUInt32BE(20)>=980 && png.readUInt32BE(20)<=12000)
    await writeFile(join(output,`${theme}-${width}.png`),png)
    evidence.push({theme,width,height:png.readUInt32BE(20),bytes:png.length,etag:created.etag})
    console.log(`PASS actual renderer PNG ${theme}/${width} with exact dashboard revision`)
  }
  const focused=await render({id:dashboard.id,width:1512,theme:"dark",focus_widget:"traffic"},created.etag)
  assert.equal(focused.status,200,"focused plot inspection must render")
  await writeFile(join(output,"focused-traffic.png"),Buffer.from(await focused.arrayBuffer()))
  const stale=await render({id:dashboard.id},'"'+"0".repeat(64)+'"')
  assert.equal(stale.status,409,"the worker must reject a different displayed revision")
  const denied=await render({id:dashboard.id},created.etag,fixture.deniedToken)
  if(denied.status===200) await writeFile(join(output,"unexpected-provider-denial.png"),Buffer.from(await denied.arrayBuffer()))
  assert.equal(denied.status,422,"missing provider access must explicitly fail without waiting for the render deadline")
  const after=await tool("get_dashboard",{id:dashboard.id},fixture.mcpViewerToken)
  assert.equal(after.etag,created.etag)
  assert.deepEqual(after.document,created.document,"screenshot inspection must not mutate saved documents")
  await verifyCanonicalCapacityRetry(dashboard)
  const denseDashboard=await verifyDenseDashboard(dashboard)
  const visualChecks=await verifyVisualChecks(provider.id)
  await verifyChecksFailClosed(dashboard)
  const probeMatrix=await verifyProbeRuleMatrix()
  await writeFile(join(output,"evidence.json"),JSON.stringify({source:"deterministic authenticated fixture",screenshots:evidence,denseDashboard,visualChecks,probeMatrix,redirectIsolationVerified:true,conditionalReadVerified:true,queryErrorRejected:true,focusedInspectionVerified:true,revisionConflictRejected:true,providerDenialRejected:true,documentUnchanged:true,capacityRetryVerified:true,persistentCapacityRejected:true},null,2))
  console.log("PASS focused inspection, revision conflict, provider denial and read-only document preservation")
} finally {
  await closeRenderBrowser()
  if(worker){worker.closeAllConnections();await new Promise(resolve=>worker.close(resolve))}
  if(processHandle && processHandle.exitCode===null){
    const stopped=once(processHandle,"exit");processHandle.kill("SIGTERM")
    const force=setTimeout(()=>processHandle.kill("SIGKILL"),5000)
    await stopped;clearTimeout(force)
  }
  await rm(temporary,{recursive:true,force:true})
}
