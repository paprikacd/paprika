"use client"

import { useMemo, useState } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { Release } from "@/gen/paprika/v1/api_pb"
import { type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

const DEFAULT_RELEASE_PAGE_SIZE = 8

interface ApplicationReleaseHistoryProps {
  releases: Release[]
  rollingBack?: string | null
  pageSize?: number
  onRollback: (release: Release) => void
}

function releasePhaseTone(phase: string): StatusTone {
  switch (phase.trim().toLowerCase()) {
    case "complete":
    case "succeeded":
      return "healthy"
    case "running":
    case "promoting":
    case "canarying":
    case "verifying":
      return "progressing"
    case "rolledback":
      return "degraded"
    case "failed":
      return "failed"
    case "pending":
    case "awaitingapproval":
      return "pending"
    case "superseded":
      return "unknown"
    default:
      return "unknown"
  }
}

function formatDate(ts?: bigint): string {
  if (ts === undefined || ts === null) return ""
  const seconds = Number(ts)
  if (!seconds) return ""
  return new Date(seconds * 1000).toLocaleString()
}

/**
 * Release history for one application. It pages rather than scrolls because
 * the list is unbounded server-side and a page keeps the DOM bounded.
 */
export function ApplicationReleaseHistory({
  releases,
  rollingBack,
  pageSize = DEFAULT_RELEASE_PAGE_SIZE,
  onRollback,
}: ApplicationReleaseHistoryProps) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(releases.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)

  const visibleReleases = useMemo(() => {
    const start = currentPage * pageSize
    return releases.slice(start, start + pageSize)
  }, [currentPage, pageSize, releases])

  const firstVisible = releases.length === 0 ? 0 : currentPage * pageSize + 1
  const lastVisible = Math.min(releases.length, (currentPage + 1) * pageSize)
  const hasPagination = releases.length > pageSize

  return (
    <Blueprint>
      <BoardHeader
        title="Release history"
        meta={
          releases.length === 0
            ? "no releases recorded"
            : `Showing ${firstVisible}-${lastVisible} of ${releases.length} app-scoped releases.`
        }
      />
      {releases.length === 0 ? (
        <p className="px-3.5 py-6 text-note text-muted-foreground">
          No releases have been recorded for this application.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-chip">
            <caption className="sr-only">
              Releases for this application, newest first
            </caption>
            <thead>
              <tr className="border-b border-rule-strong bg-muted text-left">
                <Th>Release</Th>
                <Th>Phase</Th>
                <Th>Pipeline</Th>
                <Th>Target</Th>
                <Th>Created</Th>
                <Th>Policies</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleReleases.map((release) => {
                const passed = release.policyResults.filter((p) => p.passed).length
                const total = release.policyResults.length
                const failing = total > 0 && passed < total
                return (
                  <tr key={release.name} className="border-b border-rule-soft even:bg-zebra">
                    <Td>
                      <span className="block font-semibold">{release.name}</span>
                      {release.rolledBackTo ? (
                        <span className="block text-note text-muted-foreground">
                          rolled back to {release.rolledBackTo}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <StatusPill
                        tone={releasePhaseTone(release.phase)}
                        label={release.phase || "Unknown"}
                      />
                    </Td>
                    <Td className="font-mono text-note">{release.pipeline}</Td>
                    <Td className="font-mono text-note">{release.target}</Td>
                    <Td className="text-note text-muted-foreground tabular-nums">
                      {formatDate(release.createdAt)}
                    </Td>
                    <Td className="tabular-nums">
                      {total === 0 ? (
                        <span className="text-note text-muted-foreground">
                          not evaluated
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "text-note",
                            failing ? "text-status-failed-text" : "text-status-healthy-text"
                          )}
                        >
                          {passed} / {total} passed
                        </span>
                      )}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => onRollback(release)}
                        disabled={
                          rollingBack === release.name || release.phase === "RolledBack"
                        }
                        aria-label={`Rollback ${release.name}`}
                        className="inline-flex h-11 items-center border border-rule bg-card px-2.5 text-note hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Rollback
                      </button>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasPagination ? (
        <div className="flex items-center justify-between border-t border-rule px-3.5 py-2">
          <span className="font-mono text-meta text-muted-foreground tabular-nums">
            Page {currentPage + 1} of {pageCount}
          </span>
          <span className="flex gap-1.5">
            <button
              type="button"
              aria-label="Previous releases"
              onClick={() => setPage(Math.max(0, currentPage - 1))}
              disabled={currentPage === 0}
              className="inline-flex h-11 items-center border border-rule bg-card px-2.5 text-note hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              aria-label="Next releases"
              onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
              disabled={currentPage >= pageCount - 1}
              className="inline-flex h-11 items-center border border-rule bg-card px-2.5 text-note hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </span>
        </div>
      ) : null}
    </Blueprint>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={cn("px-3.5 py-2 align-middle", className)}>{children}</td>
}
