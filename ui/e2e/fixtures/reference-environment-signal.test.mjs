// Stopping an e2e-style script that uses the reference dashboard environment must
// stop its harness, whether the signal is sent to the whole process group (Ctrl-C)
// or to the script alone. Run from ui/: npm run test:lab
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { once } from "node:events"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const child = fileURLToPath(new URL("./reference-environment-child.mjs", import.meta.url))
const repository = fileURLToPath(new URL("../../../", import.meta.url))

function processesMentioning(text) {
  const listing = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout
  return listing.split("\n").filter(line => line.includes(text) && !line.includes("ps -axo"))
}

async function startChild() {
  const script = spawn(process.execPath, [child, repository], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  script.stdout.on("data", data => { output += data })
  script.stderr.resume()
  const deadline = Date.now() + 120_000
  while (!/READY (\S+)/.test(output)) {
    if (script.exitCode !== null || Date.now() > deadline) throw new Error(`environment child did not start: ${output}`)
    await new Promise(done => setTimeout(done, 100))
  }
  return { script, temporary: /READY (\S+)/.exec(output)[1] }
}

describe("reference environment signal handling", () => {
  it("stops the harness when the script's process group receives SIGINT (Ctrl-C)", async () => {
    const { script, temporary } = await startChild()
    assert.ok(processesMentioning(temporary).length > 0, "the harness should be running")
    const exited = once(script, "exit")
    process.kill(-script.pid, "SIGINT")
    const [code, signal] = await exited
    assert.equal(signal ?? code, signal ? "SIGINT" : 130)
    assert.deepEqual(processesMentioning(temporary), [], "no harness may survive a group SIGINT")
    assert.equal(existsSync(temporary), false, "the owned workspace must be removed")
  })

  it("stops the harness when only the script receives SIGTERM", async () => {
    const { script, temporary } = await startChild()
    const exited = once(script, "exit")
    script.kill("SIGTERM")
    await exited
    assert.deepEqual(processesMentioning(temporary), [], "no harness may survive a SIGTERM to the script")
    assert.equal(existsSync(temporary), false)
  })
})
