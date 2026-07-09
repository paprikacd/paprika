"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, History, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusBadge } from "@/components/ui/status-badge"
import type { Release } from "@/gen/paprika/v1/api_pb"

const DEFAULT_RELEASE_PAGE_SIZE = 8

interface ApplicationReleaseHistoryProps {
  releases: Release[]
  rollingBack?: string | null
  pageSize?: number
  onRollback: (release: Release) => void
}

function formatDate(ts?: bigint): string {
  if (ts === undefined || ts === null) return "-"
  return new Date(Number(ts) * 1000).toLocaleString()
}

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
    <Card>
      <CardHeader className="border-b border-border/70 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Release History
            </CardTitle>
            <CardDescription>
              {releases.length === 0
                ? "Prior releases and rollbacks for this application."
                : `Showing ${firstVisible}-${lastVisible} of ${releases.length} app-scoped releases.`}
            </CardDescription>
          </div>
          {releases.length > 0 && (
            <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums ring-1 ring-foreground/10">
              {releases.length} total
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No releases found.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Phase</TableHead>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Policies</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleReleases.map((release) => (
                    <TableRow key={release.name}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{release.name}</span>
                          {release.rolledBackTo && (
                            <span className="text-xs text-muted-foreground">
                              rolled back to {release.rolledBackTo}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={release.phase} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {release.pipeline || "-"}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {release.target || "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(release.createdAt)}
                      </TableCell>
                      <TableCell>
                        {release.policyResults && release.policyResults.length > 0 ? (
                          <div className="flex items-center gap-1">
                            {release.policyResults.some((p) => !p.passed) ? (
                              <ShieldAlert className="h-4 w-4 text-red-500" />
                            ) : (
                              <ShieldCheck className="h-4 w-4 text-green-500" />
                            )}
                            <span className="text-xs">
                              {release.policyResults.filter((p) => p.passed).length} /{" "}
                              {release.policyResults.length}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onRollback(release)}
                          disabled={rollingBack === release.name || release.phase === "RolledBack"}
                        >
                          <RotateCcw className="mr-1 h-4 w-4" />
                          Rollback
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {hasPagination && (
              <div className="mt-4 flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground tabular-nums">
                  Page {currentPage + 1} of {pageCount}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Previous releases"
                    onClick={() => setPage(Math.max(0, currentPage - 1))}
                    disabled={currentPage === 0}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Next releases"
                    onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
                    disabled={currentPage >= pageCount - 1}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
