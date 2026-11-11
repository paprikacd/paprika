import {createServer} from "node:http"
import {timingSafeEqual} from "node:crypto"
import {chromium} from "playwright"

const validID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const validETag = /^"[a-f0-9]{64}"$/
const validWidths = [390, 768, 1512]
const maxBytes = 4 << 20
const maxTime = 20000
let browserPromise

const failureCategories=new Set([
  "render_failed","request_invalid","request_bounds","render_deadline",
  "browser_start","browser_context","ui_navigation","ui_readiness",
  "widget_readiness","widget_error","focus_unavailable","network_error",
  "redirect_rejected","insights_http","query_error","script_error",
  "revision_conflict","screenshot_bounds","screenshot_failed",
])

export class RenderError extends Error {
  constructor(category, status = 422, upstreamStatus) {
    super("dashboard rendering failed")
    this.category=failureCategories.has(category)?category:"render_failed"
    this.status=status
    this.upstreamStatus=upstreamStatus
  }
}

function renderFailure(error,aborted) {
  const known=error instanceof RenderError
  const category=aborted?"render_deadline":known&&failureCategories.has(error.category)?error.category:"render_failed"
  const status=aborted?504:known&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:422
  const headers={"X-Paprika-Render-Failure":category}
  if(known && Number.isInteger(error.upstreamStatus) && error.upstreamStatus>=100 && error.upstreamStatus<=599) {
    headers["X-Paprika-Render-Upstream-Status"]=String(error.upstreamStatus)
  }
  return {status,headers}
}

export function parseRenderRequest(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some(k => !["id","width","theme","focus_widget"].includes(k))) throw Error("invalid payload")
  const {id, width=1512, theme="dark", focus_widget:focusWidget=""}=v
  if (typeof id!=="string" || !validID.test(id) || !validWidths.includes(width) || !["light","dark"].includes(theme) || typeof focusWidget!=="string" ||
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

// A tile is still loading while it has a "Widget waiting to load" marker or any
// aria-busy descendant, which includes a tile waiting on a shared data source.
export const tileNotReadySelector='[aria-label="Widget waiting to load"],[aria-busy="true"]'
// A tile whose shared source failed is final, so it is rejected rather than awaited.
export const tileSourceUnavailableSelector='[data-widget-state="source-unavailable"]'

export function supportsCapacityRetry(path,method) {
  return method==="POST" && path==="/api/insights/query" ||
    method==="GET" && /^\/api\/insights\/(providers|dashboards|saved-queries)(\/[a-zA-Z0-9_-]+)?$/.test(path)
}

function trusted(actual, expected) {
  if (typeof actual!=="string" || typeof expected!=="string") return false
  const a=Buffer.from(actual), b=Buffer.from(expected)
  return a.length===b.length && timingSafeEqual(a,b)
}

// A canceled request must release its slot even during browser startup. Any
// context that finishes opening after cancellation still needs to be closed.
function abortable(promise, signal, disposeLate=()=>{}) {
  return new Promise((resolve,reject)=>{
    let aborted=false
    const abort=()=>{aborted=true;reject(signal.reason)}
    signal.addEventListener("abort",abort,{once:true})
    if(signal.aborted)abort()
    promise.then(value=>{
      signal.removeEventListener("abort",abort)
      if(aborted)void disposeLate(value)
      else resolve(value)
    },error=>{signal.removeEventListener("abort",abort);reject(error)})
  })
}

function readBody(req,signal) {
  return new Promise((resolve,reject)=>{
    const chunks=[]
    let size=0
    const cleanup=()=>{req.off("data",data);req.off("end",end);req.off("error",error);signal.removeEventListener("abort",abort)}
    const error=reason=>{cleanup();reject(reason)}
    const abort=()=>error(signal.reason)
    const data=chunk=>{
      size+=chunk.length
      if(size>2048){error(new RenderError("request_bounds",413));req.resume();return}
      chunks.push(chunk)
    }
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString("utf8"))}
    req.on("data",data);req.once("end",end);req.once("error",error)
    signal.addEventListener("abort",abort,{once:true})
    if(signal.aborted)abort()
  })
}

async function render(params, bearer, origin, signal, etag) {
  signal.throwIfAborted()
  browserPromise ??= chromium.launch({headless:true,timeout:8000,args:["--no-sandbox"]}).catch(()=>{browserPromise=undefined;throw new RenderError("browser_start")})
  const b=await abortable(browserPromise,signal)
  const context=await abortable(b.newContext({viewport:{width:params.width,height:980},colorScheme:params.theme,
    timezoneId:"Australia/Melbourne",reducedMotion:"reduce",deviceScaleFactor:1,serviceWorkers:"block"}),signal,c=>c.close().catch(()=>{}))
    .catch(()=>{throw new RenderError("browser_context")})
  const abort=()=>{void context.close().catch(()=>{})}
  signal.addEventListener("abort",abort,{once:true})
  let failure,observedETag,phase="browser_context"
  const fail=error=>{
    failure??=error
    // A known failed render must not sit in a UI readiness wait until the
    // outer deadline. Closing this request's context interrupts those waits.
    void context.close().catch(()=>{})
  }
  try {
    signal.throwIfAborted()
    await context.addInitScript(({token,theme,origin})=>{
      if(location.origin!==origin)return
      localStorage.setItem("paprika_id_token",token)
      localStorage.setItem("paprika-insights-theme",theme)
    },{token:bearer,theme:params.theme,origin})
    const page=await context.newPage()
    await page.route("**/*",async route=>{
      const req=route.request(), target=req.url()
      if (!allowedRequest(target,req.method(),origin)) {await route.abort("blockedbyclient");return}
      try {
        const headers={...req.headers()}
        if (new URL(target).pathname.startsWith("/api/insights/")) headers.authorization="Bearer "+bearer
        // Playwright's continue() carries overridden headers through redirects,
        // whose next URL does not run this route handler. Fetch exactly one
        // response so neither credentials nor browser requests leave the allowlist.
        const response=await route.fetch({headers,maxRedirects:0,timeout:maxTime})
        // Insights uses conditional reads during its regular document refresh.
        // 304 carries no navigation and must retain the UI's cached document.
        if(response.status()>=300 && response.status()<400 && response.status()!==304) {
          fail(new RenderError("redirect_rejected",422,response.status()))
          await route.abort("blockedbyclient").catch(()=>{})
          return
        }
        if(new URL(target).pathname==="/api/insights/query" && response.ok()) {
          const result=await response.json()
          if(typeof result?.error==="string" && result.error.trim()) {
            fail(new RenderError("query_error",422,response.status()))
            await route.abort("failed").catch(()=>{})
            return
          }
        }
        await route.fulfill({response})
      } catch {
        fail(new RenderError("network_error"))
        await route.abort("failed").catch(()=>{})
      }
    })
    await page.routeWebSocket("**/*",ws=>ws.close())
    page.on("pageerror",()=>{fail(new RenderError("script_error"))})
    page.on("response",response=>{
      const path=new URL(response.url()).pathname
      // The canonical client retries explicit capacity rejection on these
      // read paths. Let it finish its bounded retry; persistent failures still
      // fail the widget/error/deadline checks below, never produce a PNG.
      const retry=response.status()===429 && supportsCapacityRetry(path,response.request().method())
      if (path.startsWith("/api/insights/") && response.status()>=400 && !retry) fail(new RenderError("insights_http",422,response.status()))
      if(path==="/api/insights/dashboards/"+params.id && response.request().method()==="GET" && response.ok()) {
        observedETag=response.headers()["x-paprika-document-etag"]??response.headers().etag
        if(observedETag!==etag)fail(new RenderError("revision_conflict",409))
      }
    })
    const path="/dashboard/insights/?dashboard="+encodeURIComponent(params.id)
    phase="ui_navigation"
    await page.goto(origin+path,{waitUntil:"domcontentloaded",timeout:maxTime})
    phase="ui_readiness"
    await page.getByTestId("dashboard-canvas").waitFor({state:"visible",timeout:maxTime})
    const tiles=page.locator("[data-widget-id]")
    const rejectWidgetErrors=async target=>{
      // An authorized dashboard can reference a provider the viewer cannot
      // read. That is rendered as an alert without making a failing HTTP call.
      // A tile whose shared source failed is a final state, never a screenshot.
      if(await target.locator('[role="alert"]:visible').count() || await target.locator(tileSourceUnavailableSelector).count()) throw new RenderError("widget_error")
    }
    await tiles.first().waitFor({state:"visible",timeout:maxTime})
    const count=await tiles.count()
    if (count<1 || count>48) throw Error("dashboard canvas has no bounded widgets")
    phase="widget_readiness"
    for (let i=0;i<count;i++) {
      const tile=tiles.nth(i)
      await tile.scrollIntoViewIfNeeded()
      // Wait for both deferred mounting and query completion. A skeleton is
      // never silently accepted as a completed screenshot.
      await page.waitForFunction(([id,notReady])=>{
        const tile=document.querySelector('[data-widget-id="'+id+'"]')
        return tile && !tile.querySelector(notReady)
      },[await tile.getAttribute("data-widget-id"),tileNotReadySelector],{timeout:maxTime})
      if(failure)throw failure
      await rejectWidgetErrors(tile)
    }
    if (params.focusWidget) {
      phase="focus_unavailable"
      const panel=page.locator('[data-widget-id="'+params.focusWidget+'"]')
      if (await panel.count()!==1) throw Error("focused widget is not visible")
      await panel.scrollIntoViewIfNeeded()
      const target=panel.locator('[data-stat-sparkline][tabindex="0"],svg[role="img"][tabindex="0"],svg[role="group"][tabindex="0"]').first()
      if(await target.count()!==1) throw new RenderError("focus_unavailable")
      // Keyboard inspection selects a recorded sample independently of where
      // its plotted line happens to sit. Blind central hover may hit no data.
      await target.focus()
      await target.press("End")
      await target.press("Enter")
      await page.waitForFunction(element=>{
        const ids=(element.getAttribute("aria-describedby")??"").split(/\s+/)
        return ids.some(id=>{
          const inspector=document.getElementById(id)
          if(!inspector || !["tooltip","region"].includes(inspector.getAttribute("role")))return false
          const bounds=inspector.getBoundingClientRect()
          return bounds.width>0 && bounds.height>0 && getComputedStyle(inspector).visibility==="visible" &&
            !!inspector.querySelector("[data-observation-value],[data-metric-value],[data-observation-state]")
        })
      },await target.elementHandle(),{timeout:3000})
    } else await page.evaluate(()=>window.scrollTo(0,0))
    await page.evaluate(()=>document.fonts.ready)
    if(failure)throw failure
    await rejectWidgetErrors(page.getByTestId("dashboard-canvas"))
    signal.throwIfAborted()
    if(observedETag!==etag)throw new RenderError("revision_conflict",409)
    if(!params.focusWidget && await page.evaluate(()=>Math.max(document.documentElement.scrollHeight,document.body.scrollHeight))>12000) {
      throw new RenderError("screenshot_bounds",413)
    }
    phase="screenshot_failed"
    const png=await page.screenshot({type:"png",fullPage:!params.focusWidget,animations:"disabled",timeout:maxTime})
    if(failure)throw failure
    await rejectWidgetErrors(page.getByTestId("dashboard-canvas"))
    if (png.length>maxBytes || png.readUInt32BE(20)>12000) throw new RenderError("screenshot_bounds",413)
    return png
  } catch(error) {
    throw failure??(error instanceof RenderError?error:new RenderError(phase))
  } finally {
    signal.removeEventListener("abort",abort)
    await context.close().catch(()=>{})
  }
}

export function createRenderServer({secret,uiOrigin,renderPage=render,timeoutMs=maxTime}) {
  if (typeof secret!=="string" || Buffer.byteLength(secret)<32) throw Error("missing 32-byte render secret")
  const root=new URL(uiOrigin)
  if (root.protocol!=="http:" || root.pathname!=="/" || root.search || root.hash || root.username || root.password ||
      root.hostname==="0.0.0.0") throw Error("invalid fixed internal UI origin")
  let running=0
  const server=createServer(async(req,res)=>{
    res.setHeader("Cache-Control","no-store")
    res.setHeader("X-Content-Type-Options","nosniff")
    if(req.method==="GET" && req.url==="/healthz"){res.writeHead(200).end("ok");return}
    if (req.method!=="POST" || req.url!=="/render") {res.writeHead(404).end();return}
    if (!trusted(req.headers["x-paprika-render-secret"],secret) ||
        !/^Bearer [^\s]+$/.test(req.headers.authorization??"")) {res.writeHead(401).end();return}
    const etag=req.headers["x-paprika-dashboard-etag"]
    if(typeof etag!=="string" || !validETag.test(etag)){res.writeHead(400).end();return}
    if (running>=2) {res.setHeader("Retry-After","2");res.writeHead(429).end();return}
    running++
    const aborter=new AbortController()
    const timeout=setTimeout(()=>aborter.abort(new Error("render deadline exceeded")),timeoutMs)
    const disconnected=()=>{if (!res.writableEnded) aborter.abort()}
    res.once("close",disconnected)
    try {
      let payload
      try { payload=parseRenderRequest(JSON.parse(await readBody(req,aborter.signal))) }
      catch(error) { throw error instanceof RenderError?error:new RenderError("request_invalid") }
      const png=await renderPage(payload,req.headers.authorization.slice(7),root.origin,aborter.signal,etag)
      aborter.signal.throwIfAborted()
      res.writeHead(200,{"Content-Type":"image/png","Content-Length":png.length,"X-Paprika-Dashboard-ETag":etag}).end(png)
    } catch(error) {
      if (!res.headersSent && !res.destroyed) {
        const failure=renderFailure(error,aborter.signal.aborted)
        res.writeHead(failure.status,failure.headers).end()
      }
    } finally {
      clearTimeout(timeout)
      res.off("close",disconnected)
      running--
    }
  })
  server.headersTimeout=maxTime
  server.requestTimeout=maxTime
  return server
}

export async function closeRenderBrowser() {
  const pending=browserPromise
  browserPromise=undefined
  await pending?.then(browser=>browser.close())
}

if (process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href) {
  const server=createRenderServer({secret:process.env.PAPRIKA_RENDER_SECRET,uiOrigin:process.env.PAPRIKA_RENDER_UI_ORIGIN})
  server.listen(9081,"127.0.0.1")
  process.once("SIGTERM",()=>{server.close();void closeRenderBrowser()})
}
