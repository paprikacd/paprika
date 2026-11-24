// Builds one Go package of this repository into `output`, using the go toolchain on PATH.
// Every Insights suite that starts a Go binary goes through here, so no suite depends on a
// developer wrapper around the go command. Rejects with the compiler output on failure.
import { spawn } from "node:child_process"
import { once } from "node:events"

export async function buildGoBinary(repository, pkg, output) {
  const child = spawn("go", ["build", "-o", output, pkg], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  child.stdout.on("data", (data) => { logs += data })
  child.stderr.on("data", (data) => { logs += data })
  const [code] = await once(child, "exit")
  if (code !== 0) throw new Error(`go build ${pkg} failed with exit code ${code}:\n${logs}`)
  return output
}
