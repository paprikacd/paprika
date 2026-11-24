// Decides whether the Insights browser smoke has to run for a change (run-insights.mjs --relevance).
// The rule fails safe: the checks are skipped only when git lists at least one changed file since the base and
// every one of them matches a smokeSkipPaths glob in insights-suites.json. Any error, unknown base or empty diff runs them.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))

// Glob to RegExp for repository-relative paths: "**/" = any directories, "**" = anything, "*" = one segment.
// Every other character is literal, so "?", "[" and "{" do not widen a pattern.
export function globToRegExp(glob) {
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index]
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") { source += "(?:.*/)?"; index += 2 } else { source += ".*"; index += 1 }
    } else if (character === "*") source += "[^/]*"
    else source += character.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

// Decides from the list of changed paths. Returns { relevant, reason }.
export function decideRelevance(changed, skipPaths) {
  if (!changed.length) return { relevant: true, reason: "running: no changes recorded" }
  const skip = skipPaths.map(globToRegExp)
  const relevantFile = changed.find((file) => !skip.some((pattern) => pattern.test(file)))
  if (relevantFile !== undefined) return { relevant: true, reason: `running: ${relevantFile} changed` }
  return { relevant: false, reason: `skipped: all ${changed.length} changed files match smokeSkipPaths` }
}

function defaultGit(args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  return result.status === 0 ? result.stdout : undefined
}

// The files changed between `base` and HEAD, or undefined when git cannot tell. Renames are listed as a
// deletion plus an addition (--no-renames), so a file moved out of a code path still counts as changed there.
export function changedFiles(base, git = defaultGit) {
  const diff = git(["diff", "--name-only", "--no-renames", "--no-ext-diff", "-z", base, "HEAD", "--"])
  return diff === undefined ? undefined : diff.split("\0").filter(Boolean)
}

export function relevance(base, skipPaths, git = defaultGit) {
  if (typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base) || /^0+$/.test(base)) {
    return { relevant: true, reason: `running: base "${base}" is not a commit id` }
  }
  if (git(["cat-file", "-e", `${base}^{commit}`]) === undefined) {
    git(["fetch", "--no-tags", "--depth=1", "origin", base])
    if (git(["cat-file", "-e", `${base}^{commit}`]) === undefined) return { relevant: true, reason: `running: base ${base} is not available` }
  }
  const changed = changedFiles(base, git)
  if (changed === undefined) return { relevant: true, reason: `running: cannot diff against ${base}` }
  const decision = decideRelevance(changed, skipPaths)
  return { relevant: decision.relevant, reason: `${decision.reason} since ${base}` }
}
