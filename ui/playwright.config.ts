import { defineConfig, devices } from "@playwright/test"

const baseURL = "http://127.0.0.1:3100"
const desktopViewport = { width: 1920, height: 1080 }
const useExternalServer = process.env.PLAYWRIGHT_NO_WEBSERVER === "1"

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "line",
  use: {
    baseURL,
    viewport: desktopViewport,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: useExternalServer
    ? undefined
    : {
        command:
          "./bin/fleet-console-fixture --listen 127.0.0.1:3100 --assets ui/out --applications 250",
        cwd: "..",
        url: `${baseURL}/readyz`,
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
