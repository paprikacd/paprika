// Process supervision for the local Insights tools (the design lab and the
// real-provider gallery). Every child starts in its own process group and is
// recorded, with its start time, in a per-run JSON file. Shutdown stops whole
// groups, runs recorded cleanup commands and removes recorded paths. A later
// start recovers only records that name the same tool and whose processes still
// match their recorded start times, so unrelated processes are never touched.
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"

const signals = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))

/** Start time of a live process, or null. Used to tell a recorded process from a reused PID. */
export function processStart(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })
  const value = result.stdout?.trim()
  return value ? value : null
}

function groupAlive(groupID) {
  try {
    process.kill(-groupID, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

async function waitUntil(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

/**
 * Stops a process group: SIGTERM, then SIGKILL after the grace period. Returns
 * true when the group is gone.
 */
export async function stopProcessGroup(groupID, { graceMilliseconds = 5000, killMilliseconds = 3000 } = {}) {
  if (!groupAlive(groupID)) return true
  try { process.kill(-groupID, "SIGTERM") } catch { /* Already exiting. */ }
  if (await waitUntil(() => !groupAlive(groupID), graceMilliseconds)) return true
  try { process.kill(-groupID, "SIGKILL") } catch { /* Already gone. */ }
  return waitUntil(() => !groupAlive(groupID), killMilliseconds)
}

function removeAllowed(path, allowedRoots, log) {
  const target = resolve(path)
  if (!allowedRoots.some(root => target.startsWith(resolve(root) + sep))) {
    log(`Not removing ${target}: outside the directories this tool owns.`)
    return
  }
  rmSync(target, { recursive: true, force: true })
}

async function runCommand(command, args, log) {
  const child = spawn(command, args, { stdio: "inherit" })
  const [code] = await once(child, "exit").catch(() => [1])
  if (code !== 0) log(`${command} ${args[0] ?? ""} exited with ${code}.`)
}

/**
 * Creates a supervisor for one run. `tool` names the owner; `recordDirectory`
 * holds the run records; `allowedRoots` limits what may be removed.
 */
export function createRunSupervisor({ tool, recordDirectory, allowedRoots, log = message => console.error(message), graceMilliseconds = 5000 }) {
  const recordFile = join(recordDirectory, `${tool}-${process.pid}-${Date.now()}.json`)
  const record = { tool, supervisor: { pid: process.pid, start: processStart(process.pid) }, children: [], removePaths: [], commands: [] }
  const cleanups = []
  let shutdown = null
  let exitCode = 0

  function save() {
    mkdirSync(recordDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(recordFile, JSON.stringify(record, null, 2), { mode: 0o600 })
  }

  // Records a process group leader. Accepts a ChildProcess (forgotten when it
  // exits) or a bare PID. `start` overrides the live start time; tests use it to
  // simulate a reused PID.
  function adopt(label, target, { start } = {}) {
    const pid = typeof target === "number" ? target : target.pid
    const entry = { label, pid, start: start ?? processStart(pid) }
    record.children.push(entry)
    save()
    if (typeof target !== "number") {
      target.once("exit", () => {
        record.children = record.children.filter(child => child !== entry)
        save()
      })
    }
    return entry
  }

  // Signals a recorded group only while its leader still has the recorded start
  // time. A PID reused by an unrelated process is never signalled.
  async function stopRecorded(entry) {
    if (!entry.start || processStart(entry.pid) !== entry.start) {
      log(`Not signalling ${entry.label} (pid ${entry.pid}): the recorded process is no longer running.`)
      return
    }
    await stopProcessGroup(entry.pid, { graceMilliseconds })
  }

  async function stopEverything(reason) {
    log(`Stopping (${reason})…`)
    await Promise.all(record.children.map(stopRecorded))
    for (const fn of cleanups.reverse()) {
      try { await fn() } catch (error) { log(`Cleanup failed: ${error.message}`) }
    }
    for (const command of record.commands) await runCommand(command.command, command.args, log)
    for (const path of record.removePaths) removeAllowed(path, allowedRoots, log)
    rmSync(recordFile, { force: true })
  }

  const supervisor = {
    recordFile,
    get stopping() { return shutdown !== null },
    /** Starts a child in its own process group and records it before returning. */
    spawnChild(label, command, args, options = {}) {
      const child = spawn(command, args, { detached: true, stdio: "ignore", ...options })
      if (!child.pid) throw new Error(`Could not start ${label}`)
      adopt(label, child)
      return child
    },
    adopt,
    addRemovePath(path) {
      record.removePaths.push(resolve(path))
      save()
    },
    addCommand(label, command, args) {
      record.commands.push({ label, command, args })
      save()
    },
    addCleanup(fn) {
      cleanups.push(fn)
    },
    /** Stops everything this run started, once, without exiting the process. */
    stop(reason = "requested") {
      shutdown ??= stopEverything(reason)
      return shutdown
    },
    /** Starts shutdown once. Later calls return the same promise and exit with the first code. */
    requestShutdown(code, reason) {
      if (!shutdown) {
        exitCode = code
        shutdown = stopEverything(reason).finally(() => process.exit(exitCode))
      }
      return shutdown
    },
    /** Ctrl-C, SIGTERM and SIGHUP start shutdown. Repeated signals are ignored while it runs. */
    installSignalHandlers() {
      for (const [signal, code] of signals) {
        process.on(signal, () => {
          if (shutdown) log(`${signal} received; already stopping, waiting for cleanup to finish.`)
          else supervisor.requestShutdown(code, signal)
        })
      }
      process.on("uncaughtException", error => {
        log(error.stack ?? String(error))
        supervisor.requestShutdown(1, "uncaught error")
      })
    },
  }
  return supervisor
}

/**
 * Stops and removes the runs of `tool` that are not alive. A record whose
 * supervisor is still running is left alone. Unreadable records are kept.
 */
export async function recoverOrphans({ tool, recordDirectory, allowedRoots, log = message => console.error(message) }) {
  if (!existsSync(recordDirectory)) return 0
  let recovered = 0
  for (const name of readdirSync(recordDirectory).sort()) {
    if (!name.startsWith(`${tool}-`) || !name.endsWith(".json")) continue
    const file = join(recordDirectory, name)
    let record
    try { record = JSON.parse(readFileSync(file, "utf8")) } catch { continue }
    if (record.tool !== tool) continue
    const supervisor = record.supervisor
    if (supervisor?.start && processStart(supervisor.pid) === supervisor.start) continue
    log(`Recovering an earlier ${tool} run (${name}).`)
    for (const child of record.children ?? []) {
      if (child.start && processStart(child.pid) === child.start) {
        await stopProcessGroup(child.pid)
        recovered += 1
      }
    }
    for (const command of record.commands ?? []) await runCommand(command.command, command.args, log)
    for (const path of record.removePaths ?? []) removeAllowed(path, allowedRoots, log)
    rmSync(file, { force: true })
  }
  return recovered
}
