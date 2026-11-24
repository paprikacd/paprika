#!/usr/bin/env node
// node hack/insights-patch/cli.mjs <set.json> [--apply] [--receipt out.json]
// Reads PAPRIKA_OBSERVE_URL (the MCP endpoint) and PAPRIKA_OBSERVE_TOKEN (a write-capable Observe token).
// Without --apply it prints the plan and writes nothing. The receipt never contains the token.
import { writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { apply, loadPatchSet, plan, receiptOf } from "./apply.mjs"

// The same JSON-RPC framing the Insights browser suite uses against the Observe MCP endpoint.
export function mcpCall(url, token) {
  let rpcId = 0
  async function rpc(method, params) {
    const id = ++rpcId
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-03-26" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status !== 200) throw new Error(`MCP ${method}: HTTP ${response.status}`)
    const text = await response.text()
    return response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id)
      : JSON.parse(text)
  }
  return async (name, args) => {
    const response = await rpc("tools/call", { name, arguments: args })
    if (response.error) throw new Error(`${name}: ${response.error.message}`)
    const text = response.result?.content?.find(item => item.type === "text")?.text
    if (response.result?.isError) throw new Error(`${name}: ${text ?? "failed"}`)
    return response.result.structuredContent ?? JSON.parse(text)
  }
}

function printPlan(items, print) {
  for (const item of items) {
    const kind = item.collection === "dashboards" ? "dashboard" : "saved query"
    print(`~ ${kind} ${item.id}: ${item.state}`)
    if (item.changes) {
      const lines = [
        ...(item.changes.dashboard.changes.length ? [`  dashboard: ${item.changes.dashboard.changes.map(change => change.path).join(", ")}`] : []),
        ...item.changes.widgets.map(widget => `  ${widget.title || widget.id}: ${widget.diff.changes.map(change => change.path).join(", ")}`),
      ]
      for (const line of lines) print(line)
    }
  }
}

/** Runs the CLI. Returns the process exit code. `makeCall` may be replaced by tests. */
export async function runCli({ argv, env, makeCall = mcpCall, print = console.log, printError = console.error }) {
  const [setPath, ...rest] = argv
  const receiptIndex = rest.indexOf("--receipt")
  const receiptPath = receiptIndex >= 0 ? rest[receiptIndex + 1] : undefined
  const doApply = rest.includes("--apply")
  if (!setPath || (receiptIndex >= 0 && !receiptPath)) {
    printError("usage: node hack/insights-patch/cli.mjs <set.json> [--apply] [--receipt out.json]")
    return 2
  }
  const url = env.PAPRIKA_OBSERVE_URL
  const token = env.PAPRIKA_OBSERVE_TOKEN
  if (!url || !token) {
    printError("Set PAPRIKA_OBSERVE_URL and PAPRIKA_OBSERVE_TOKEN.")
    return 2
  }
  const startedAt = new Date().toISOString()
  let receipt
  let exitCode = 0
  try {
    const set = await loadPatchSet(setPath)
    const call = makeCall(url, token)
    const planned = await plan(call, set)
    printPlan(planned, print)
    if (doApply) {
      receipt = await apply(call, planned)
      printPlan(receipt.items, print)
      if (receipt.error) {
        printError(`stopped: ${receipt.error}`)
        exitCode = 1
      }
    } else {
      receipt = receiptOf(planned, { startedAt })
      print("dry run: pass --apply to write these changes")
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    printError(`not applied: ${message}`)
    receipt = receiptOf([], { startedAt, error: message })
    exitCode = 1
  } finally {
    if (receiptPath) await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  }
  return exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli({ argv: process.argv.slice(2), env: process.env })
}
