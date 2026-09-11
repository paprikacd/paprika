"use client"

import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"

type DiffLineKind = "file" | "hunk" | "add" | "delete" | "context"
type DiffFilter = "all" | "changes" | "additions" | "deletions"

export interface ParsedDiffLine {
  id: string
  raw: string
  text: string
  kind: DiffLineKind
  oldLine?: number
  newLine?: number
  oldSpan?: number
  newSpan?: number
}

export interface DiffSummary {
  additions: number
  deletions: number
  hunks: number
  context: number
}

/** One RFC 6902 operation, derived from a drifted field the server reported. */
export interface JsonPatchOperation {
  op: "replace"
  path: string
  value: unknown
}

const filterLabels: Record<DiffFilter, string> = {
  all: "All lines",
  changes: "Changes only",
  additions: "Additions",
  deletions: "Deletions",
}

/** Three columns: desired line number, live line number, the text itself. */
const diffGrid = "grid grid-cols-[3.25rem_3.25rem_minmax(0,1fr)]"

export function summarizeUnifiedDiff(diff: string): DiffSummary {
  return parseUnifiedDiff(diff).reduce<DiffSummary>(
    (summary, line) => {
      if (line.kind === "add") summary.additions += 1
      else if (line.kind === "delete") summary.deletions += 1
      else if (line.kind === "hunk") summary.hunks += 1
      else if (line.kind === "context") summary.context += 1
      return summary
    },
    { additions: 0, deletions: 0, hunks: 0, context: 0 },
  )
}

export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  if (!diff.trim()) return []
  let oldLine = 0
  let newLine = 0

  return diff.split("\n").map((raw, index) => {
    if (raw.startsWith("---") || raw.startsWith("+++")) {
      return {
        id: `${index}-file`,
        raw,
        text: raw.replace(/^[-+]{3}\s?/, "").trim(),
        kind: "file",
      }
    }

    if (raw.startsWith("@@")) {
      const match = raw.match(/@@\s-(\d+)(?:,(\d+))?\s\+(\d+)(?:,(\d+))?\s@@/)
      oldLine = match ? Number(match[1]) : oldLine
      newLine = match ? Number(match[3]) : newLine
      return {
        id: `${index}-hunk`,
        raw,
        text: raw,
        kind: "hunk",
        oldSpan: match?.[2] ? Number(match[2]) : 1,
        newSpan: match?.[4] ? Number(match[4]) : 1,
      }
    }

    if (raw.startsWith("+")) {
      const current = newLine
      newLine += 1
      return {
        id: `${index}-add`,
        raw,
        text: raw.slice(1),
        kind: "add",
        newLine: current,
      }
    }

    if (raw.startsWith("-")) {
      const current = oldLine
      oldLine += 1
      return {
        id: `${index}-delete`,
        raw,
        text: raw.slice(1),
        kind: "delete",
        oldLine: current,
      }
    }

    const currentOld = oldLine
    const currentNew = newLine
    oldLine += 1
    newLine += 1
    return {
      id: `${index}-context`,
      raw,
      text: raw.startsWith(" ") ? raw.slice(1) : raw,
      kind: "context",
      oldLine: currentOld,
      newLine: currentNew,
    }
  })
}

export function filterDiffLines(
  lines: readonly ParsedDiffLine[],
  filter: DiffFilter,
): ParsedDiffLine[] {
  return lines.filter((line) => {
    if (filter === "all") return true
    if (line.kind === "file" || line.kind === "hunk") return true
    if (filter === "changes") return line.kind === "add" || line.kind === "delete"
    if (filter === "additions") return line.kind === "add"
    return line.kind === "delete"
  })
}

/**
 * The unified pane the workbench draws: a caption strip naming the object,
 * then the parsed lines. Deliberately chrome-free — the workbench supplies
 * its own header, counts and mode switch above it.
 */
export function UnifiedDiffPane({
  diff,
  caption,
  labelledBy,
}: {
  diff: string
  caption?: string
  labelledBy?: string
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])

  if (lines.length === 0) return <DiffEmptyState />

  return (
    <div className="border border-rule bg-card">
      {caption ? <DiffCaption>{caption}</DiffCaption> : null}
      <div className={cn(diffGrid, "border-b border-rule bg-inset px-2.5 py-1 font-mono text-meta text-neutral-700")}>
        <span>Desired</span>
        <span>Live</span>
        <span>Manifest</span>
      </div>
      <div aria-labelledby={labelledBy} className="overflow-x-auto font-mono text-reason leading-[1.85]">
        {lines.map((line) => (
          <DiffLineRow key={line.id} line={line} />
        ))}
      </div>
    </div>
  )
}

/**
 * Side-by-side. Same parse, re-laid out: deletions sit on the desired side,
 * additions on the live side, and context repeats on both.
 */
export function SplitDiffPane({
  diff,
  caption,
  labelledBy,
}: {
  diff: string
  caption?: string
  labelledBy?: string
}) {
  const rows = useMemo(() => toSplitRows(parseUnifiedDiff(diff)), [diff])

  if (rows.length === 0) return <DiffEmptyState />

  return (
    <div className="border border-rule bg-card">
      {caption ? <DiffCaption>{caption}</DiffCaption> : null}
      <div className="grid grid-cols-2 border-b border-rule bg-inset font-mono text-meta text-neutral-700">
        <span className="border-r border-rule px-2.5 py-1">Desired</span>
        <span className="px-2.5 py-1">Live</span>
      </div>
      <div aria-labelledby={labelledBy} className="overflow-x-auto font-mono text-reason leading-[1.85]">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-2">
            <SplitCell
              className="border-r border-rule-faint"
              line={row.left}
              number={row.left?.oldLine}
              tone={row.left?.kind === "delete" ? "delete" : "context"}
            />
            <SplitCell
              line={row.right}
              number={row.right?.newLine}
              tone={row.right?.kind === "add" ? "add" : "context"}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

interface SplitRow {
  id: string
  left?: ParsedDiffLine
  right?: ParsedDiffLine
}

export function toSplitRows(lines: readonly ParsedDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let pendingDeletes: ParsedDiffLine[] = []
  let pendingAdds: ParsedDiffLine[] = []

  const flush = () => {
    const height = Math.max(pendingDeletes.length, pendingAdds.length)
    for (let index = 0; index < height; index += 1) {
      const left = pendingDeletes[index]
      const right = pendingAdds[index]
      rows.push({ id: `${left?.id ?? "-"}|${right?.id ?? "-"}`, left, right })
    }
    pendingDeletes = []
    pendingAdds = []
  }

  for (const line of lines) {
    if (line.kind === "delete") {
      pendingDeletes.push(line)
      continue
    }
    if (line.kind === "add") {
      pendingAdds.push(line)
      continue
    }
    flush()
    if (line.kind === "context") {
      rows.push({ id: line.id, left: line, right: line })
    }
  }
  flush()
  return rows
}

function SplitCell({
  line,
  number,
  tone,
  className,
}: {
  line?: ParsedDiffLine
  number?: number
  tone: "add" | "delete" | "context"
  className?: string
}) {
  if (!line) {
    return <span className={cn("block bg-zebra px-2.5", className)}>&nbsp;</span>
  }
  return (
    <span className={cn("flex px-2.5", toneClass(tone), className)}>
      <span aria-hidden className="w-7.5 shrink-0 pr-3 text-right text-diff-gutter select-none">
        {number ?? ""}
      </span>
      <span className="whitespace-pre">{line.text || " "}</span>
    </span>
  )
}

/**
 * Renders the RFC 6902 document derived from the drifted-field list. This is
 * not a second opinion about the diff: every operation comes from a field the
 * server reported, addressed by the JSON pointer it supplied.
 */
export function JsonPatchPane({
  operations,
  caption,
  labelledBy,
}: {
  operations: readonly JsonPatchOperation[]
  caption?: string
  labelledBy?: string
}) {
  const text = useMemo(() => JSON.stringify(operations, null, 2), [operations])

  return (
    <div className="border border-rule bg-card">
      {caption ? <DiffCaption>{caption}</DiffCaption> : null}
      <pre
        aria-labelledby={labelledBy}
        className="overflow-x-auto px-2.5 py-2 font-mono text-reason leading-[1.85] text-diff-ctx-text"
      >
        {text}
      </pre>
    </div>
  )
}

/**
 * Turns the server's drifted fields into replace operations. `desired` and
 * `live` arrive as strings, so a token that is valid JSON is emitted as that
 * value and anything else stays a string — the alternative would quote every
 * number and produce a patch that does not mean what it says.
 */
export function buildJsonPatch(
  fields: readonly { path: string; desired: string; ignored?: boolean }[],
): JsonPatchOperation[] {
  return fields
    .filter((field) => !field.ignored && field.path !== "")
    .map((field) => ({
      op: "replace" as const,
      path: field.path,
      value: parseFieldValue(field.desired),
    }))
}

function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return ""
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return raw
  }
}

function DiffCaption({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-rule px-3 py-1.5 font-mono text-meta text-neutral-700">
      {children}
    </div>
  )
}

function DiffEmptyState() {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-1.5 border border-rule bg-card px-4 py-10 text-center">
      <p className="font-cond text-card font-semibold tracking-[0.02em]">No differences</p>
      <p className="max-w-sm text-note text-neutral-700">
        The live manifest matches desired for this resource.
      </p>
    </div>
  )
}

/**
 * The application-detail diff: the same rows, wrapped in counts and a line
 * filter. The workbench uses {@link UnifiedDiffPane} instead, because it draws
 * its own header.
 */
export function SyncDiffView({ diff }: { diff: string }) {
  const [filter, setFilter] = useState<DiffFilter>("all")
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const summary = useMemo(() => summarizeUnifiedDiff(diff), [diff])
  const targetLines = useMemo(() => {
    const lastHunk = lines.findLast((line) => line.kind === "hunk")
    return lastHunk?.newSpan ?? summary.additions + summary.context
  }, [lines, summary.additions, summary.context])

  const visibleLines = useMemo(() => filterDiffLines(lines, filter), [filter, lines])

  if (lines.length === 0) return <DiffEmptyState />

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col gap-3 border border-rule bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-cond text-card font-semibold tracking-[0.02em]">Desired to live diff</p>
          <p className="text-note text-neutral-700">
            Server-cleaned manifests with Kubernetes-managed fields removed.
          </p>
        </div>
        <div className="grid grid-cols-4 gap-1.5 text-center sm:min-w-80">
          <DiffStat value={summary.additions} label={plural(summary.additions, "addition")} tone="add" />
          <DiffStat value={summary.deletions} label={plural(summary.deletions, "deletion")} tone="delete" />
          <DiffStat value={summary.hunks} label={plural(summary.hunks, "hunk")} tone="neutral" />
          <DiffStat value={targetLines} label="target lines" tone="neutral" />
        </div>
      </div>

      <div role="group" aria-label="Diff line filter" className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(filterLabels) as DiffFilter[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={cn(
              "inline-flex min-h-11 items-center rounded-[2px] border px-2 text-note sm:min-h-0 sm:py-0.5",
              filter === id
                ? "border-primary bg-selected text-steel-800"
                : "border-rule bg-card text-neutral-700 hover:bg-inset",
            )}
          >
            {filterLabels[id]}
          </button>
        ))}
      </div>

      <div className="border border-rule bg-card">
        <div className={cn(diffGrid, "border-b border-rule bg-inset px-2.5 py-1 font-mono text-meta text-neutral-700")}>
          <span>Desired</span>
          <span>Live</span>
          <span>Manifest</span>
        </div>
        <div className="max-h-[62vh] overflow-auto font-mono text-reason leading-[1.85]">
          {visibleLines.map((line) => (
            <DiffLineRow key={line.id} line={line} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One rendered diff line. The add/delete colours are the diff family, not the
 * status tones: a removed line is not a failure, and colouring it like one
 * would make every diff read as an incident.
 */
export function DiffLineRow({ line }: { line: ParsedDiffLine }) {
  if (line.kind === "file") {
    return (
      <div className={cn(diffGrid, "border-t border-rule-faint bg-inset px-2.5 text-neutral-700")}>
        <span />
        <span />
        <span className="font-sans text-note font-semibold">{line.text || line.raw}</span>
      </div>
    )
  }

  if (line.kind === "hunk") {
    return (
      <div className={cn(diffGrid, "border-t border-rule-faint bg-scope-active px-2.5 text-steel-800")}>
        <span />
        <span />
        <span className="whitespace-pre">{line.raw}</span>
      </div>
    )
  }

  const tone = line.kind === "add" ? "add" : line.kind === "delete" ? "delete" : "context"
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "

  return (
    <div className={cn(diffGrid, "px-2.5", toneClass(tone))}>
      <span aria-hidden className="text-diff-gutter tabular-nums select-none">
        {line.oldLine ?? ""}
      </span>
      <span aria-hidden className="text-diff-gutter tabular-nums select-none">
        {line.newLine ?? ""}
      </span>
      <span className="whitespace-pre">
        <span aria-hidden className="pr-2 text-diff-gutter select-none">
          {marker}
        </span>
        {line.text || " "}
      </span>
    </div>
  )
}

function toneClass(tone: "add" | "delete" | "context") {
  if (tone === "add") return "bg-diff-add-bg text-diff-add-text"
  if (tone === "delete") return "bg-diff-del-bg text-diff-del-text"
  return "text-diff-ctx-text"
}

function DiffStat({
  value,
  label,
  tone,
}: {
  value: number
  label: string
  tone: "add" | "delete" | "neutral"
}) {
  return (
    <div className="border border-rule bg-card px-2 py-1">
      <span className="sr-only">
        {value} {label}
      </span>
      <div
        aria-hidden
        className={cn(
          "font-mono text-console font-semibold tabular-nums",
          tone === "add" ? "text-diff-add-text" : tone === "delete" ? "text-diff-del-text" : "text-foreground",
        )}
      >
        {value}
      </div>
      <div aria-hidden className="text-meta text-neutral-700">
        {label}
      </div>
    </div>
  )
}

function plural(value: number, word: string) {
  return `${word}${value === 1 ? "" : "s"}`
}
