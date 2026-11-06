import {createServer} from "node:http"
import {timingSafeEqual} from "node:crypto"
import {chromium} from "playwright"

const validID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const validWidths = [390, 768, 1512]
const maxBytes = 4 << 20
const maxTime = 20000
let running = 0
let browserPromise

export function parseRenderRequest(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some(k => !["id","width","theme","focus_widget"].includes(k))) throw Error("invalid payload")
  const id=v.id, width=v.width??1512, theme=v.theme??"dark", focusWidget=v.focus_widget??""
  if (!validID.test(id) || !validWidths.includes(width) || !["light","dark"].includes(theme) ||
      (focusWidget && !validID.test(focusWidget))) throw Error("invalid dashboard preview arguments")
  return {id,width,theme,focusWidget}
}

export function allowedRequest(url, method, origin) {
  let u
  try { u=new URL(url) } catch { return false }
  if (u.origin!==origin || u.username || u.password) return false
  if (u.pathname.startsWith("/api/insights/")) {
    if (method==="GET") return /^\/api\/insights\/(providers|dashboards|saved-queries|schemas|observe-connection)(\/[a-zA-Z0-9_-]+)?$/.test(u.pathname)
    return method==="POST" && u.pathname==="/api/insights/query"
  }
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/") && u.pathname!=="/auth/config") return false
  return method==="GET" && (
    u.pathname.startsWith("/dashboard/insights/") ||
    u.pathname.startsWith("/_next/") ||
    u.pathname.startsWith("/images/") ||
    u.pathname.startsWith("/assets/") ||
    u.pathname==="/auth/config" ||
    u.pathname==="/favicon.ico" ||
    u.pathname==="/icon.png")
}

function trusted(actual, expected) {
  if (typeof actual!=="string" || typeof expected!=="string") return false
  const a=Buffer.from(actual), b=Buffer.from(expected)
  return a.length===b.length && timingSafeEqual(a,b)
}

async function render(params, bearer, origin, signal) {
  browserPromise ??= chromium.launch({headless:true,args:["--no-sandbox"]}).catch(e=>{browserPromise=undefined;throw e})
  const b=await browserPromise
  const context=await b.newContext({viewport:{width:params.width,height:980},colorScheme:params.theme,
    timezoneId:"Australia/Melbourne",reducedMotion:"reduce",deviceScaleFactor:1,serviceWorkers:"block"})
  const abort=()=>{void context.close().catch(()=>{})}
  signal.addEventListener("abort",abort,{once:true})
  try {
    await context.addInitScript(({token,theme})=>{
      localStorage.setItem("paprika_id_token",token)
      localStorage.setItem("paprika-insights-theme",theme)
    },{token:bearer,theme:params.theme})
    const page=await context.newPage()
    let failed=false
    await page.route("**/*",async route=>{
      const req=route.request(), target=req.url()
      if (!allowedRequest(target,req.method(),origin)) {await route.abort("blockedbyclient");return}
      if (new URL(target).pathname.startsWith("/api/insights/")) {
        await route.continue({headers:{...req.headers(),authorization:"Bearer "+bearer}})
      } else await route.continue()
    })
    await page.routeWebSocket("**/*",ws=>ws.close())
    page.on("pageerror",()=>{failed=true})
    page.on("response",response=>{
      if (new URL(response.url()).pathname.startsWith("/api/insights/") && response.status()>=400) failed=true
    })
    const path="/dashboard/insights/?dashboard="+encodeURIComponent(params.id)
    await page.goto(origin+path,{waitUntil:"domcontentloaded",timeout:maxTime})
    await page.getByTestId("dashboard-canvas").waitFor({state:"visible",timeout:maxTime})
    const tiles=page.locator("[data-widget-id]")
    const count=await tiles.count()
    if (count<1 || count>48) throw Error("dashboard canvas has no bounded widgets")
    for (let i=0;i<count;i++) {
      const tile=tiles.nth(i)
      await tile.scrollIntoViewIfNeeded()
      await tile.locator('[aria-busy="true"]').first().waitFor({state:"hidden",timeout:1500}).catch(()=>{})
    }
    if (params.focusWidget) {
      const panel=page.locator('[data-widget-id="'+params.focusWidget+'"]')
      if (await panel.count()!==1) throw Error("focused widget is not visible")
      await panel.scrollIntoViewIfNeeded()
      const target=panel.locator('svg[role="img"],svg[role="group"],[data-metric-value]').first()
      if (await target.count()) await target.hover({timeout:3000}).catch(()=>{})
    } else await page.evaluate(()=>window.scrollTo(0,0))
    await page.evaluate(()=>document.fonts.ready)
    if (failed || signal.aborted) throw Error("render failed")
    const png=await page.screenshot({type:"png",fullPage:!params.focusWidget,animations:"disabled",timeout:maxTime})
    if (png.length>maxBytes) throw Error("PNG exceeds 4 MiB")
    return png
  } finally {
    signal.removeEventListener("abort",abort)
    await context.close().catch(()=>{})
  }
}

export function createRenderServer({secret,uiOrigin}) {
  if (typeof secret!=="string" || secret.length<32) throw Error("missing 32-byte render secret")
  const root=new URL(uiOrigin)
  if (root.protocol!=="http:" || root.pathname!=="/" || root.search || root.username || root.password ||
      root.hostname==="0.0.0.0") throw Error("invalid fixed internal UI origin")
  return createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store")
    res.setHeader("X-Content-Type-Options","nosniff")
    if (req.method!=="POST" || req.url!=="/render") {res.writeHead(404).end();return}
    if (!trusted(req.headers["x-paprika-render-secret"],secret) ||
        !/^Bearer [^\s]+$/.test(req.headers.authorization??"")) {res.writeHead(401).end();return}
    if (running>=2) {res.setHeader("Retry-After","2");res.writeHead(429).end();return}
    running++
    const aborter=new AbortController()
    const timeout=setTimeout(()=>aborter.abort(),maxTime)
    const disconnected=()=>{if (!res.writableEnded) aborter.abort()}
    res.once("close",disconnected)
    try {
      const chunks=[]
      let size=0
      for await(const chunk of req) {
        size+=chunk.length
        if(size>2048)throw Error("payload exceeds limit")
        chunks.push(chunk)
      }
      const payload=parseRenderRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      const png=await render(payload,req.headers.authorization.slice(7),root.origin,aborter.signal)
      if (!aborter.signal.aborted) res.writeHead(200,{"Content-Type":"image/png","Content-Length":png.length}).end(png)
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(aborter.signal.aborted?504:422).end()
    } finally {
      clearTimeout(timeout)
      res.off("close",disconnected)
      running--
    }
  })
}

if (process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href) {
  const server=createRenderServer({secret:process.env.PAPRIKA_RENDER_SECRET,uiOrigin:process.env.PAPRIKA_RENDER_UI_ORIGIN})
  server.listen(9081,"127.0.0.1")
  process.once("SIGTERM",()=>server.close())
}
