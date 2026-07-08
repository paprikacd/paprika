"use client"

import { useMemo, useState } from "react"
import { CheckCircle2, GitCompare, Rows3 } from "lucide-react"

type DiffLineKind = "file" | "hunk" | "add" | "delete" | "context"
type DiffFilter = "all" | "changes" | "additions" | "deletions"

interface ParsedDiffLine {
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

const filterLabels: Record<DiffFilter, string> = {
  all: "All lines",
  changes: "Changes only",
  additions: "Additions",
  deletions: "Deletions",
}

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

export function SyncDiffView({ diff }: { diff: string }) {
  const [filter, setFilter] = useState<DiffFilter>("all")
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const summary = useMemo(() => summarizeUnifiedDiff(diff), [diff])
  const targetLines = useMemo(() => {
    const lastHunk = lines.findLast((line) => line.kind === "hunk")
    return lastHunk?.newSpan ?? summary.additions + summary.context
  }, [lines, summary.additions, summary.context])

  const visibleLines = useMemo(
    () =>
      lines.filter((line) => {
        if (filter === "all") return true
        if (line.kind === "file" || line.kind === "hunk") return true
        if (filter === "changes") return line.kind === "add" || line.kind === "delete"
        if (filter === "additions") return line.kind === "add"
        return line.kind === "delete"
      }),
    [filter, lines],
  )

  if (lines.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 rounded-xl bg-muted/20 px-4 py-12 text-center ring-1 ring-foreground/10">
        <CheckCircle2 className="size-6 text-emerald-500" />
        <p className="text-sm font-medium text-foreground/80">No differences</p>
        <p className="max-w-sm text-sm text-muted-foreground text-pretty">
          The live manifest matches desired for this resource.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl bg-muted/20 p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-foreground/10">
            <GitCompare className="size-4 text-foreground/80" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">Desired to live diff</p>
            <p className="text-xs text-muted-foreground text-pretty">
              Server-cleaned manifests with Kubernetes-managed fields removed.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-center text-xs sm:min-w-80">
          <DiffStat value={summary.additions} label={plural(summary.additions, "addition")} tone="add" />
          <DiffStat value={summary.deletions} label={plural(summary.deletions, "deletion")} tone="delete" />
          <DiffStat value={summary.hunks} label={plural(summary.hunks, "hunk")} tone="neutral" />
          <DiffStat value={targetLines} label="target lines" tone="neutral" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Rows3 className="size-4 text-muted-foreground" />
        {(Object.keys(filterLabels) as DiffFilter[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`min-h-10 rounded-lg px-3 text-xs font-medium transition-[background-color,color,box-shadow,scale] active:scale-[0.96] ${
              filter === id
                ? "bg-foreground text-background shadow-sm"
                : "bg-muted/30 text-muted-foreground ring-1 ring-foreground/10 hover:text-foreground"
            }`}
          >
            {filterLabels[id]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl bg-background font-mono text-xs ring-1 ring-foreground/10">
        <div className="grid grid-cols-[4rem_4rem_minmax(0,1fr)] border-b border-foreground/10 bg-muted/30 px-2 py-2 text-[11px] font-medium text-muted-foreground">
          <span>Desired</span>
          <span>Live</span>
          <span>Manifest</span>
        </div>
        <div className="max-h-[62vh] overflow-auto">
          {visibleLines.map((line) => (
            <DiffLineRow key={line.id} line={line} />
          ))}
        </div>
      </div>
    </div>
  )
}

function DiffLineRow({ line }: { line: ParsedDiffLine }) {
  if (line.kind === "file") {
    return (
      <div className="grid grid-cols-[4rem_4rem_minmax(0,1fr)] border-t border-foreground/5 bg-muted/20 px-2 py-1.5 text-muted-foreground">
        <span />
        <span />
        <span className="font-sans text-xs font-medium">{line.text || line.raw}</span>
      </div>
    )
  }

  if (line.kind === "hunk") {
    return (
      <div className="grid grid-cols-[4rem_4rem_minmax(0,1fr)] border-t border-foreground/5 bg-primary/10 px-2 py-1.5 text-primary">
        <span />
        <span />
        <span>{line.raw}</span>
      </div>
    )
  }

  const tone =
    line.kind === "add"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : line.kind === "delete"
        ? "bg-destructive/10 text-destructive"
        : "text-muted-foreground"
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "

  return (
    <div className={`grid grid-cols-[4rem_4rem_minmax(0,1fr)] px-2 py-0.5 ${tone}`}>
      <span className="select-none text-muted-foreground/60 tabular-nums">{line.oldLine ?? ""}</span>
      <span className="select-none text-muted-foreground/60 tabular-nums">{line.newLine ?? ""}</span>
      <span className="whitespace-pre-wrap break-words">
        <span className="select-none pr-2 text-muted-foreground/60">{marker}</span>
        {line.text || "\u00a0"}
      </span>
    </div>
  )
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
  const toneClass =
    tone === "add" ? "text-emerald-600 dark:text-emerald-300" : tone === "delete" ? "text-destructive" : "text-foreground"
  return (
    <div className="rounded-lg bg-background px-2 py-1.5 ring-1 ring-foreground/10">
      <span className="sr-only">
        {value} {label}
      </span>
      <div className={`text-sm font-semibold tabular-nums ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

function plural(value: number, word: string) {
  return `${word}${value === 1 ? "" : "s"}`
}
