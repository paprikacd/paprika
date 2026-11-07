// MCP-authored documents -> authenticated real Insights UI -> isolated Chromium
// worker. Kubernetes and telemetry are deterministic fixtures, never live claims.
import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {randomBytes} from "node:crypto"
import {once} from "node:events"
import {createServer} from "node:http"
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join,resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {createRenderServer,closeRenderBrowser} from "../render-worker.mjs"

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
  await writeFile(join(output,"evidence.json"),JSON.stringify({source:"deterministic authenticated fixture",screenshots:evidence,redirectIsolationVerified:true,conditionalReadVerified:true,queryErrorRejected:true,focusedInspectionVerified:true,revisionConflictRejected:true,providerDenialRejected:true,documentUnchanged:true},null,2))
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
