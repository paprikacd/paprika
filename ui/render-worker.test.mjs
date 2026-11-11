import {test} from "node:test"
import assert from "node:assert/strict"
import {request} from "node:http"
import {Window} from "happy-dom"
import * as worker from "./render-worker.mjs"
import {parseRenderRequest,allowedRequest,createRenderServer,RenderError,supportsCapacityRetry,tileNotReadySelector,tileSourceUnavailableSelector,wantsJSON,checkReport,maxCheckIssues} from "./render-worker.mjs"

test("strict viewport, identity and no arbitrary URL",()=>{
  assert.deepEqual(parseRenderRequest({id:"board"}),{id:"board",width:1512,theme:"dark",focusWidget:"",checksOnly:false})
  for(const invalid of [{},{id:null},{id:123},{id:["board"]},{id:"board",focus_widget:42},{id:"board",width:null},{id:"board",theme:null},{id:"../secrets"},{id:"board",width:1920},{id:"board",theme:"invalid"},{id:"board",url:"https://example.com"},{id:"board",checks_only:"yes"},{id:"board",checks_only:true,focus_widget:"traffic"}])
    assert.throws(()=>parseRenderRequest(invalid))
})

const secret="abcdefghijklmnopqrstuvwxyz0123456789"
const etag='"'+"a".repeat(64)+'"'
const headers={authorization:"Bearer delegated-read-token","x-paprika-render-secret":secret,"x-paprika-dashboard-etag":etag}

async function withServer(options,run) {
  const server=createRenderServer({secret,uiOrigin:"http://paprika-e2e-api-server:3000/",...options})
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  try { await run("http://127.0.0.1:"+server.address().port) }
  finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)) }
}

test("requires an exact revision before starting a browser and echoes captured revision",async()=>{
  let renders=0
  await withServer({renderPage:async(params,token,origin,signal,version)=>{
    renders++
    assert.equal(params.id,"board");assert.equal(token,"delegated-read-token")
    assert.equal(origin,"http://paprika-e2e-api-server:3000");assert.equal(signal.aborted,false)
    assert.equal(version,etag)
    return {png:Buffer.from("fixture PNG")}
  }},async origin=>{
    for(const version of ["*","invalid",'W/'+etag,undefined]) {
      const sent={...headers};if(version===undefined)delete sent["x-paprika-dashboard-etag"];else sent["x-paprika-dashboard-etag"]=version
      assert.equal((await fetch(origin+"/render",{method:"POST",headers:sent,body:'{"id":"board"}'})).status,400)
    }
    assert.equal(renders,0)
    const response=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    assert.equal(response.status,200);assert.equal(response.headers.get("x-paprika-dashboard-etag"),etag)
    assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(renders,1)
  })
})

test("body deadline releases capacity without an ended request body",async()=>{
  await withServer({timeoutMs:60,renderPage:async()=>({png:Buffer.from("fixture PNG")})},async origin=>{
    const stalled=()=>new Promise((resolve,reject)=>{
      const req=request(origin+"/render",{method:"POST",headers},res=>{res.resume();res.once("end",()=>resolve(res.statusCode))})
      req.on("error",reject)
      req.write('{"id":') // Intentionally do not finish the body.
    })
    assert.deepEqual(await Promise.all([stalled(),stalled()]),[504,504])
    const response=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    assert.equal(response.status,200,"timed-out bodies must release both render slots")
  })
})

test("bounded concurrency and canceled clients release render slots",async()=>{
  let entered=0
  const pending=[]
  await withServer({renderPage:async(params,token,origin,signal)=>{
    entered++
    return new Promise((resolve,reject)=>{
      pending.push(resolve)
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true})
    })
  }},async origin=>{
    const firstController=new AbortController()
    const first=fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}',signal:firstController.signal}).catch(()=>null)
    const second=fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    const deadline=Date.now()+2000
    while(entered<2 && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5))
    assert.equal(entered,2)
    const overflow=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    assert.equal(overflow.status,429);assert.equal(overflow.headers.get("retry-after"),"2")
    firstController.abort();await first
    pending[1]({png:Buffer.from("fixture PNG")});assert.equal((await second).status,200)
  })
})

test("sandbox only allows first-party read APIs and static UI",()=>{
  const origin="http://paprika-e2e-api-server:3000"
  assert.equal(allowedRequest(origin+"/dashboard/insights/?dashboard=board","GET",origin),true)
  assert.equal(allowedRequest(origin+"/api/insights/query","POST",origin),true)
  assert.equal(allowedRequest(origin+"/api/insights/dashboards/board","GET",origin),true)
  assert.equal(allowedRequest(origin+"/api/insights/dashboards/board","PUT",origin),false)
  assert.equal(allowedRequest(origin+"/api/insights/provider-configs","GET",origin),false)
  assert.equal(allowedRequest("http://169.254.169.254/latest/meta-data","GET",origin),false)
  assert.equal(allowedRequest("https://example.com/collect","GET",origin),false)
})

test("render worker rejects missing and invalid authentication",async()=>{
  const secret="abcdefghijklmnopqrstuvwxyz0123456789"
  const server=createRenderServer({secret,uiOrigin:"http://paprika-e2e-api-server:3000/"})
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve))
  try {
    const url="http://127.0.0.1:"+server.address().port+"/render"
    for(const headers of [{},{authorization:"Bearer a"},{"x-paprika-render-secret":"bad",authorization:"Bearer a"}]) {
      const r=await fetch(url,{method:"POST",body:"{}",headers})
      assert.equal(r.status,401)
    }
  } finally {
    await new Promise(resolve=>server.close(resolve))
  }
})

test("render failures expose only fixed categories and numeric HTTP statuses",async()=>{
  const privateText="https://private.example/path?token=never-echo Bearer delegated-read-token "+secret
  const unknown=new Error(privateText)
  unknown.category=privateText;unknown.status=503;unknown.upstreamStatus=privateText
  const changed=new RenderError("insights_http",422,429)
  changed.category=privateText;changed.message=privateText;changed.upstreamStatus=privateText
  for(const [error,category,upstream] of [
    [unknown,"render_failed",null],
    [changed,"render_failed",null],
    [new RenderError(privateText),"render_failed",null],
    [new RenderError("insights_http",422,429),"insights_http","429"],
    [new RenderError("redirect_rejected",422,302),"redirect_rejected","302"],
    [new RenderError("query_error",422,200),"query_error","200"],
    [new RenderError("insights_http",422,"429"),"insights_http",null],
    [new RenderError("insights_http",422,700),"insights_http",null],
  ]) {
    error.stack=privateText
    await withServer({renderPage:async()=>{throw error}},async origin=>{
      const response=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
      assert.equal(response.status,422)
      assert.equal(response.headers.get("x-paprika-render-failure"),category)
      assert.equal(response.headers.get("x-paprika-render-upstream-status"),upstream)
      const body=await response.text()
      assert.equal(body,"")
      const wire=JSON.stringify([...response.headers])+body
      for(const forbidden of ["private.example","never-echo","delegated-read-token",secret]) assert.equal(wire.includes(forbidden),false)
    })
  }
})

test("deadline diagnostics retain the existing timeout status without exception text",async()=>{
  await withServer({timeoutMs:30,renderPage:async(params,token,origin,signal)=>new Promise((resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(new Error("private browser exception "+token)),{once:true})
  })},async origin=>{
    const response=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    assert.equal(response.status,504)
    assert.equal(response.headers.get("x-paprika-render-failure"),"render_deadline")
    assert.equal(await response.text(),"")
  })
})

// Real tile markup captured from the Insights canvas: the pending tile waits on
// /providers, the unavailable tile names a failed source. The loaded tile is the
// same tile after the listing arrives.
const pendingTile=`<article class="_tile_aa0e36 " data-widget-id="inline" data-widget-type="timeseries" aria-label="Inline latency"><div class="_tileHeader_aa0e36"><div class="_tileTitle_aa0e36"><h3>Inline latency</h3></div></div><div class="_visualization_aa0e36"><div class="_visualization_59c41b _loadingFrame_59c41b" data-widget-state-frame="" aria-busy="true"><div class="_state_59c41b" data-widget-state="waiting-for-sources" aria-busy="true"><span>Waiting for data sources…</span></div></div></div></article>`
const unavailableTile=`<article class="_tile_aa0e36 " data-widget-id="inline" data-widget-type="timeseries" aria-label="Inline latency"><div class="_tileHeader_aa0e36"><div class="_tileTitle_aa0e36"><h3>Inline latency</h3></div></div><div class="_visualization_aa0e36"><div class="_visualization_59c41b" data-widget-state-frame=""><div class="_state_59c41b" data-widget-state="source-unavailable"><span>Data sources are unavailable. Retry data sources to load this tile.</span></div></div></div></article>`
const loadedTile=`<article data-widget-id="inline" data-widget-type="timeseries" aria-label="Inline latency"><div class="_visualization" data-widget-state-frame=""><svg role="img" aria-label="Inline latency"></svg></div></article>`

function documentWith(markup) {
  const window=new Window()
  window.document.body.innerHTML=markup
  return window.document
}

// The worker's wait predicate, exactly as page.waitForFunction evaluates it.
function tileReady(document,id) {
  const tile=document.querySelector('[data-widget-id="'+id+'"]')
  return !!tile && !tile.querySelector(tileNotReadySelector)
}

test("a pending tile is not ready while /providers is delayed, then is ready once it arrives",()=>{
  const document=documentWith(pendingTile)
  assert.equal(tileReady(document,"inline"),false,"a pending tile must keep the worker waiting")
  assert.equal(document.querySelector('[data-widget-id="inline"]').querySelector(tileSourceUnavailableSelector),null)
  // /providers resolves: the same tile re-renders with its data.
  document.body.innerHTML=loadedTile
  assert.equal(tileReady(document,"inline"),true)
})

test("an unavailable tile is ready for the predicate but is rejected as a final widget state",()=>{
  const document=documentWith(unavailableTile)
  assert.equal(tileReady(document,"inline"),true)
  assert.notEqual(document.querySelector('[data-widget-id="inline"]').querySelector(tileSourceUnavailableSelector),null,"the worker must reject this tile")
  assert.equal(documentWith(pendingTile).querySelector(tileSourceUnavailableSelector),null)
})

test("GET /providers is a capacity-retry read, while writes and provider configuration are not",()=>{
  assert.equal(supportsCapacityRetry("/api/insights/providers","GET"),true)
  assert.equal(supportsCapacityRetry("/api/insights/query","POST"),true)
  assert.equal(supportsCapacityRetry("/api/insights/providers","POST"),false)
  assert.equal(supportsCapacityRetry("/api/insights/provider-configs","GET"),false)
})

// The page client replays a busy listing; the worker must not add a replay layer.
test("the worker exports no listing replay, so a busy spell is replayed once, by the page client",()=>{
  assert.deepEqual(Object.keys(worker).filter(name=>/busy|replay/i.test(name)),[])
})

test("a busy tile waiting on the client's replays is not ready, and a final unavailable tile is rejected",()=>{
  const waiting=documentWith(pendingTile)
  assert.equal(tileReady(waiting,"inline"),false,"the worker keeps waiting while the client replays")
  const unavailable=documentWith(unavailableTile)
  assert.notEqual(unavailable.querySelector('[data-widget-id="inline"]').querySelector(tileSourceUnavailableSelector),null)
})

test("JSON is opt-in through Accept or checks_only, and PNG callers keep the image body",()=>{
  assert.equal(wantsJSON("application/json"),true)
  assert.equal(wantsJSON("image/png, application/json;q=0.9"),true)
  assert.equal(wantsJSON("image/png"),false)
  assert.equal(wantsJSON("*/*"),false)
  assert.equal(wantsJSON(""),false)
})

test("check reports keep at most the wire bound and count every finding",()=>{
  const findings=Array.from({length:maxCheckIssues+8},(_,i)=>({ruleId:"visual.internal-scroll",severity:"SEVERITY_WARNING",source:"SOURCE_VISUAL",widgetId:"w"+i,pointer:"",message:"m",fix:"f"}))
  assert.deepEqual(checkReport(null),null)
  const report=checkReport(findings)
  assert.equal(report.issues.length,maxCheckIssues)
  assert.equal(report.total,maxCheckIssues+8)
  assert.equal(report.truncated,true)
  assert.deepEqual(checkReport([]),{issues:[],total:0,truncated:false})
})

test("visual checks return JSON with findings, timings and the image, and checks_only omits the image",async()=>{
  const finding={ruleId:"visual.empty-plot",severity:"SEVERITY_WARNING",source:"SOURCE_VISUAL",widgetId:"plot",pointer:"",message:"Chart area has data but nothing is drawn.",fix:"Check the series options."}
  const seen=[]
  await withServer({renderPage:async(params)=>{
    seen.push(params)
    return params.checksOnly?{checks:checkReport([finding]),timings:{readyMs:3,probeMs:1,renderMs:5}}:{png:Buffer.from("fixture PNG"),checks:checkReport([finding]),timings:{readyMs:3,probeMs:1,renderMs:9}}
  }},async origin=>{
    const withImage=await fetch(origin+"/render",{method:"POST",headers:{...headers,accept:"application/json"},body:'{"id":"board"}'})
    assert.equal(withImage.status,200)
    assert.equal(withImage.headers.get("content-type"),"application/json")
    assert.equal(withImage.headers.get("x-paprika-dashboard-etag"),etag)
    const body=await withImage.json()
    assert.equal(Buffer.from(body.png,"base64").toString(),"fixture PNG")
    assert.deepEqual(body.checks,{issues:[finding],total:1,truncated:false})
    assert.deepEqual(body.timings,{readyMs:3,probeMs:1,renderMs:9})
    assert.equal(seen.at(-1).checks,true)

    const checksOnly=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board","checks_only":true}'})
    assert.equal(checksOnly.status,200)
    const only=await checksOnly.json()
    assert.equal("png" in only,false,"checks_only never carries an image")
    assert.equal(only.checks.total,1)
    assert.equal(seen.at(-1).checksOnly,true)

    const plain=await fetch(origin+"/render",{method:"POST",headers,body:'{"id":"board"}'})
    assert.equal(plain.headers.get("content-type"),"image/png")
    assert.equal(seen.at(-1).checks,false,"PNG-only callers do not pay for the probe")
    await plain.arrayBuffer()
  })
})
