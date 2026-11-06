import {test} from "node:test"
import assert from "node:assert/strict"
import {parseRenderRequest,allowedRequest,createRenderServer} from "./render-worker.mjs"

test("strict viewport, identity and no arbitrary URL",()=>{
  assert.deepEqual(parseRenderRequest({id:"board"}),{id:"board",width:1512,theme:"dark",focusWidget:""})
  for(const invalid of [{id:"../secrets"},{id:"board",width:1920},{id:"board",theme:"invalid"},{id:"board",url:"https://example.com"}])
    assert.throws(()=>parseRenderRequest(invalid))
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
