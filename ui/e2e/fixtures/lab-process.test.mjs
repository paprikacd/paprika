// Process-supervision tests for the design lab and the gallery wrapper. Run from ui/: npm run test:lab
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { createRunSupervisor, processStart, recoverOrphans, stopProcessGroup } from "./lab-process.mjs"

const child = fileURLToPath(new URL("./lab-process-child.mjs", import.meta.url))
const quiet = () => {}

function groupGone(groupID) {
  try { process.kill(-groupID, 0); return false } catch (error) { return error.code === "ESRCH" }
}

async function eventually(predicate, message, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(done => setTimeout(done, 50))
  }
  assert.fail(message)
}

function startFixture(recordDirectory, workDirectory, mode) {
  const fixture = spawn(process.execPath, [child, recordDirectory, workDirectory, mode], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  fixture.stdout.on("data", data => { output += data })
  fixture.stderr.resume()
  // Subscribe before the child can exit: a crash-mode child may exit before `ready` is awaited.
  const exited = once(fixture, "exit")
  return { fixture, exited, ready: () => new Promise((resolve, reject) => {
    const check = () => {
      const line = output.split("\n").find(Boolean)
      if (line) return resolve(JSON.parse(line))
      if (fixture.exitCode !== null) return reject(new Error("fixture exited before reporting"))
      setTimeout(check, 25)
    }
    check()
  }) }
}

describe("run supervisor", () => {
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    it(`stops the whole group and removes recorded paths after two ${signal} signals`, async () => {
      const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
      const records = join(work, "runs")
      try {
        const { fixture, exited, ready } = startFixture(records, work, "normal")
        const { leader, scratch } = await ready()
        assert.equal(existsSync(scratch), true)
        fixture.kill(signal)
        fixture.kill(signal)
        const [exitCode] = await exited
        assert.equal(exitCode, code, "a repeated signal must not change the exit code or kill cleanup")
        await eventually(() => groupGone(leader), "child process group survived shutdown")
        assert.equal(existsSync(scratch), false, "recorded temporary workspace must be removed")
        assert.deepEqual(readdirSync(records), [], "run record must be removed after clean shutdown")
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    })
  }

  it("recovers a SIGKILLed run without touching unrelated processes", async () => {
    const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
    const records = join(work, "runs")
    const unrelated = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
    try {
      const { exited, ready } = startFixture(records, work, "crash")
      const { leader, scratch } = await ready()
      await exited
      assert.equal(existsSync(scratch), true, "a SIGKILLed run cannot clean up by itself")
      const recovered = await recoverOrphans({ tool: "lab-process-test", recordDirectory: records, allowedRoots: [work], log: quiet })
      assert.equal(recovered, 1)
      await eventually(() => groupGone(leader), "orphaned child group survived recovery")
      assert.equal(existsSync(scratch), false)
      assert.equal(groupGone(unrelated.pid), false, "an unrelated process group must be left running")
      assert.deepEqual(readdirSync(records), [])
    } finally {
      await stopProcessGroup(unrelated.pid)
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("does not recover records of another tool", async () => {
    const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
    const records = join(work, "runs")
    try {
      const { exited, ready } = startFixture(records, work, "crash")
      const { leader } = await ready()
      await exited
      const recovered = await recoverOrphans({ tool: "some-other-tool", recordDirectory: records, allowedRoots: [work], log: quiet })
      assert.equal(recovered, 0)
      assert.equal(groupGone(leader), false)
      await stopProcessGroup(leader)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("refuses to remove paths outside the allowed roots", async () => {
    const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
    const records = join(work, "runs")
    const outside = mkdtempSync(join(tmpdir(), "lab-process-outside-"))
    try {
      const { exited, ready } = startFixture(records, work, "crash")
      await ready()
      await exited
      await recoverOrphans({ tool: "lab-process-test", recordDirectory: records, allowedRoots: [outside], log: quiet })
      assert.equal(existsSync(join(work, "temporary-workspace")), true, "paths outside the allowed roots are never removed")
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("does not signal a recorded process whose start time no longer matches (reused PID)", async () => {
    const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
    const unrelated = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
    try {
      await new Promise(done => setTimeout(done, 100))
      const supervisor = createRunSupervisor({ tool: "reuse-test", recordDirectory: join(work, "runs"), allowedRoots: [work], log: quiet, graceMilliseconds: 200 })
      // The record says this PID started at another time, as if it were reused by an unrelated process.
      supervisor.adopt("reused", unrelated.pid, { start: "Thu Jan  1 00:00:00 1970" })
      assert.notEqual(processStart(unrelated.pid), "Thu Jan  1 00:00:00 1970")
      await supervisor.stop("test")
      assert.equal(groupGone(unrelated.pid), false, "an unrelated process group must not be signalled on shutdown")
    } finally {
      await stopProcessGroup(unrelated.pid)
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("forgets a child once it exits, so shutdown never signals a stale PID", async () => {
    const work = mkdtempSync(join(tmpdir(), "lab-process-test-"))
    const records = join(work, "runs")
    try {
      const supervisor = createRunSupervisor({ tool: "exit-test", recordDirectory: records, allowedRoots: [work], log: quiet })
      const short = supervisor.spawnChild("short build", "true", [])
      await once(short, "exit")
      const remaining = JSON.parse(readFileSync(supervisor.recordFile, "utf8")).children
      assert.deepEqual(remaining, [], "an exited child must be removed from the record")
      await supervisor.stop("test")
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
