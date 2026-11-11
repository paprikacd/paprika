// Test-only supervisor process for lab-process.test.mjs. Usage:
//   node lab-process-child.mjs <recordDirectory> <workDirectory> <normal|crash>
import { mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRunSupervisor } from "./lab-process.mjs"

const [recordDirectory, workDirectory, mode] = process.argv.slice(2)
const tool = "lab-process-test"
const scratch = join(workDirectory, "temporary-workspace")
mkdirSync(scratch, { recursive: true })
writeFileSync(join(scratch, "ready.json"), JSON.stringify({ token: "test-only-not-a-credential" }))
const supervisor = createRunSupervisor({ tool, recordDirectory, allowedRoots: [workDirectory], log: message => console.error(message) })
supervisor.addRemovePath(scratch)
const group = supervisor.spawnChild("sleepers", "sh", ["-c", "sleep 300 & sleep 300 & wait"], { stdio: "ignore" })
supervisor.installSignalHandlers()
// Give the shell a moment to start its sleep children before reporting.
setTimeout(() => {
  // Synchronous: a pipe write is asynchronous and would be lost when the crash below ends the process.
  writeSync(1, JSON.stringify({ leader: group.pid, scratch }) + "\n")
  if (mode === "crash") process.kill(process.pid, "SIGKILL")
}, 300)
