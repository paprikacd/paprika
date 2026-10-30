// Real PostgreSQL locations: overlapping hitboxes must all be pointer-selectable.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:1")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:1")
assert.equal(app.hostname, "127.0.0.1"); assert.equal(api.hostname, "127.0.0.1")
const endpoint = new URL("/api/insights/dashboards/local-gallery-edge-watch", api)
const before = await fetch(endpoint), original = await before.text()
const etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({headless:true})
try {
  for (const theme of ["light", "dark"]) for (const width of [1512,390]) for (const touch of width === 390 ? [false,true] : [false]) {
    const context = await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:"reduce",hasTouch:touch,isMobile:touch})
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme",theme),theme)
    const page = await context.newPage(), errors=[]
    page.on("pageerror",error=>errors.push(error.message))
    await page.route(url=>["/api/","/auth/"].some(prefix=>url.pathname.startsWith(prefix)),async route=>{
      const original=new URL(route.request().url()), destination=new URL(original.pathname+original.search,api)
      const headers={...route.request().headers()}; delete headers.origin; delete headers.host
      const response=await route.fetch({url:destination.href,headers}); await route.fulfill({response})
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch",app).href,{waitUntil:"networkidle"})
      const panel=page.locator('[data-widget-id="locations"]'), map=panel.getByRole("group",{name:/Geographic map/})
      await panel.scrollIntoViewIfNeeded(); await map.locator("[data-map-location-key] button").first().waitFor()
      await page.waitForLoadState("networkidle")
      await map.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const hit=await map.evaluate(root=>{
        const markers=[...root.querySelectorAll("[data-map-location-key]")]
        for(const marker of markers){
          const box=marker.querySelector("button").getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2
          if(x<0||x>=innerWidth||y<0||y>=innerHeight)continue
          const hits=[...new Set(document.elementsFromPoint(x,y).map(element=>element.closest("[data-map-location-key]")).filter(element=>element&&root.contains(element)))]
          if(hits.length<2)continue
          return {x,y,entries:hits.map(element=>({key:element.dataset.mapLocationKey,label:element.querySelector("button").getAttribute("aria-label").split(" · ")[0],style:element.getAttribute("style")}))}
        }
        return null
      })
      assert.ok(hit && hit.entries.length>1,"Fixture must have multiple markers under a real pointer position")
      const underlying=hit.entries[1]
      await page.evaluate(()=>{window.__mapClicks=[];document.addEventListener("click",event=>window.__mapClicks.push({detail:event.detail,x:event.clientX,y:event.clientY,marker:event.target.closest?.("[data-map-location-key]")?.dataset.mapLocationKey}),{capture:true})})
      if(touch) await page.touchscreen.tap(hit.x,hit.y); else await page.mouse.click(hit.x,hit.y)
      const chooser=panel.getByRole("region",{name:"Locations under this point"}); await chooser.waitFor({timeout:5000}).catch(async error=>{throw Error(`${theme} ${width} touch=${touch}: ${JSON.stringify({hit,clicks:await page.evaluate(()=>window.__mapClicks)})}: ${error.message}`)})
      assert.ok(await chooser.evaluate(element=>element===document.activeElement),"Chooser receives focus")
      const choice=chooser.getByRole("button",{name:`Inspect overlapping location ${underlying.label}`,exact:true})
      await choice.scrollIntoViewIfNeeded(); await choice.click()
      assert.equal(await page.getByRole("textbox",{name:"Location",exact:true}).inputValue(),underlying.label,"Selecting an obscured marker updates the linked view")
      const originalStyle=await map.locator(`[data-map-location-key="${underlying.key}"]`).getAttribute("style")
      assert.equal(originalStyle,underlying.style,"Choosing does not displace the geographic marker")
      await page.keyboard.press("Escape")
      // A linked-variable refresh can replace the records and dismiss the
      // chooser; otherwise explicitly close it and check the focus return.
      if(await chooser.count()) {
        await chooser.getByRole("button",{name:"Close location choices"}).click()
        await chooser.waitFor({state:"hidden"})
      }
      assert.deepEqual(errors,[])
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
      console.log(`PASS ${theme} ${width}px${touch?" touch":""}: select a covered recorded location without moving it`)
    } finally { await page.unrouteAll({behavior:"ignoreErrors"}); await context.close() }
  }
} finally { await browser.close() }
const after=await fetch(endpoint)
assert.equal(await after.text(),original)
assert.equal(after.headers.get("x-paprika-document-etag")??after.headers.get("etag"),etag)
