import {test} from "node:test"
import assert from "node:assert/strict"
import {request} from "node:http"
import {parseRenderRequest,allowedRequest,createRenderServer,RenderError} from "./render-worker.mjs"

test("strict viewport, identity and no arbitrary URL",()=>{
  assert.deepEqual(parseRenderRequest({id:"board"}),{id:"board",width:1512,theme:"dark",focusWidget:""})
  for(const invalid of [{},{id:null},{id:123},{id:["board"]},{id:"board",focus_widget:42},{id:"board",width:null},{id:"board",theme:null},{id:"../secrets"},{id:"board",width:1920},{id:"board",theme:"invalid"},{id:"board",url:"https://example.com"}])
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
    return Buffer.from("fixture PNG")
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
  await withServer({timeoutMs:60,renderPage:async()=>Buffer.from("fixture PNG")},async origin=>{
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
    pending[1](Buffer.from("fixture PNG"));assert.equal((await second).status,200)
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
