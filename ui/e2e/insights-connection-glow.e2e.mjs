// Exercise source-record geography, threshold styling and interaction in a real browser.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const origin = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015").origin
const browser = await chromium.launch({headless:true})
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 1050},hasTouch:width === 390,isMobile:width === 390,reducedMotion:"reduce"})
    await context.addInitScript(({origin,theme}) => {if(location.origin === origin) localStorage.setItem("paprika-insights-theme",theme)}, {origin,theme})
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      const api = await installRichChartFixtureAPI(page, origin)
      const board = api.documents.get("example-artboard-edge-watch")
      const map = board.widgets.find(widget => widget.id === "locations")
      map.config = {...map.config,display:"density",showLocations:false}
      map.options = {...map.options, thresholds:[{value:0,color:"#00cadd",label:"Low"},{value:1000,color:"#f5ab2f",label:"Medium"},{value:2000,color:"#f54c40",label:"High"}]}
      map.selectionBindings = [{variable:"location",source:"label",value:"label"}]
      board.variables.push({name:"location",label:"Location",defaultValue:"unset"})
      board.widgets = [map]
      await page.goto(`${origin}/dashboard/insights/?dashboard=${board.id}`,{waitUntil:"networkidle"})
      const tile = page.locator('[data-widget-id="locations"]')
      const marker = tile.getByRole("button",{name:/^Melbourne ·/})
      await marker.waitFor({timeout:30000})
      const legend = tile.getByRole("group",{name:"Location value thresholds"})
      assert.match(await legend.innerText(),/Low.*Medium.*High/s)
      assert.equal(await tile.locator('[data-map-plane] line').count(),0)
      assert.equal(await marker.locator("..").evaluate(element => element.style.getPropertyValue("--point-color")),"#f5ab2f")
      await marker.focus()
      const tooltip = page.getByRole("tooltip"); await tooltip.waitFor()
      await tooltip.getByText("144.9600°").waitFor()
      assert.ok(!page.url().includes("Melbourne"),"Focus must inspect without selecting")
      await marker.press("Enter")
      await page.waitForURL(/Melbourne/)
      await page.keyboard.press("Escape")
      const explore = tile.getByText("Explore locations")
      await explore.click()
      const row = tile.getByRole("button",{name:"Inspect location Melbourne"})
      await row.waitFor()
      if (width === 390) assert.ok((await row.boundingBox()).height >= 44,"The location list provides full-sized touch targets")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false)
      assert.deepEqual(errors,[]); assert.deepEqual(api.failures,[])
      if (process.env.INSIGHTS_SCREENSHOT_DIR) {
        await mkdir(process.env.INSIGHTS_SCREENSHOT_DIR,{recursive:true})
        await page.screenshot({path:join(process.env.INSIGHTS_SCREENSHOT_DIR,`map-${theme}-${width}.png`),animations:"disabled"})
      }
      console.log(`PASS ${theme} ${width}px: exact location glow, threshold color, inspection and selection`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
