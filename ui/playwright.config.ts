import { defineConfig, devices } from "@playwright/test"
import { join } from "node:path"

const fixturePort = positivePort(process.env.PAPRIKA_E2E_PORT ?? "3100")
const baseURL = process.env.PAPRIKA_E2E_BASE_URL ?? `http://127.0.0.1:${fixturePort}`
const desktopViewport = { width: 1920, height: 1080 }
const useExternalServer = process.env.PLAYWRIGHT_NO_WEBSERVER === "1"
const trace = process.env.PAPRIKA_E2E_TRACE === "on" ? "on" : "retain-on-failure"
const artifactRoot = process.env.PAPRIKA_E2E_OUTPUT_DIR ?? "test-results"
const outputDir = join(artifactRoot, "test-results")
const reportDir = join(artifactRoot, "playwright-report")
const resultsFile = join(artifactRoot, "results.json")

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: reportDir }],
    ["json", { outputFile: resultsFile }],
  ],
  outputDir,
  use: {
    baseURL,
    viewport: desktopViewport,
    trace,
    screenshot: "only-on-failure",
  },
  webServer: useExternalServer
    ? undefined
    : {
        command:
          `./bin/fleet-console-fixture --listen 127.0.0.1:${fixturePort} --assets ui/out --applications 250`,
        cwd: "..",
        url: new URL("/readyz", baseURL).toString(),
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: desktopViewport,
        contextOptions: { reducedMotion: "no-preference" },
      },
    },
    {
      name: "chromium-reduced-motion",
      use: {
        ...devices["Desktop Chrome"],
        viewport: desktopViewport,
        contextOptions: { reducedMotion: "reduce" },
      },
    },
    {
      name: "chromium-keyboard-only",
      use: {
        ...devices["Desktop Chrome"],
        viewport: desktopViewport,
        contextOptions: { reducedMotion: "no-preference" },
      },
    },
  ],
})

function positivePort(raw: string) {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PAPRIKA_E2E_PORT must be an integer from 1 to 65535; got ${JSON.stringify(raw)}`)
  }
  return port
}
