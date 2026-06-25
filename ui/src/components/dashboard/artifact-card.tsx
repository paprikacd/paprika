"use client"

import { useState } from "react"
import { Copy, Download, Check } from "lucide-react"

import type { ArtifactRef } from "@/gen/paprika/v1/api_pb"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { copyToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

function truncateDigest(digest: string): string {
  if (!digest) return ""
  if (digest.length <= 18) return digest
  return `${digest.slice(0, 18)}…`
}

function formatCreatedAt(ts: bigint): string {
  const ms = Number(ts) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return ""
  return new Date(ms).toLocaleString()
}

function phaseClassName(phase: string): string {
  switch (phase) {
    case "Ready":
    case "Succeeded":
      return "bg-success/10 text-success border-success/20"
    case "Failed":
      return "bg-destructive/10 text-destructive border-destructive/20"
    case "Pending":
      return "bg-warning/10 text-warning border-warning/20"
    default:
      return "bg-muted text-muted-foreground border-border/50"
  }
}

function refToCopy(artifact: ArtifactRef): string {
  return artifact.resolvedReference || artifact.reference || artifact.name
}

interface ArtifactCardProps {
  artifact: ArtifactRef
  /**
   * Optional download URL (e.g. a base64 JSON data URI for ConfigMap artifacts
   * under the size limit). When present, a Download link is rendered instead of
   * the "Copy reference" button.
   */
  downloadUrl?: string
  className?: string
}

export function ArtifactCard({ artifact, downloadUrl, className }: ArtifactCardProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await copyToClipboard(refToCopy(artifact))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable; ignore
    }
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 text-sm shadow-xs",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium">{artifact.name}</p>
          {artifact.digest && (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {truncateDigest(artifact.digest)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {artifact.kind && (
            <Badge variant="outline" className="font-mono text-[10px]">
              {artifact.kind}
            </Badge>
          )}
          {artifact.phase && (
            <Badge className={cn("text-[10px]", phaseClassName(artifact.phase))}>
              {artifact.phase}
            </Badge>
          )}
        </div>
      </div>

      {artifact.phase === "Failed" && artifact.failedReason && (
        <p className="mt-2 text-xs text-destructive">{artifact.failedReason}</p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {formatCreatedAt(artifact.createdAt)}
        </span>
        {downloadUrl ? (
          <a
            className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
            href={downloadUrl}
            download={`${artifact.name}.json`}
          >
            <Download className="size-3" />
            Download
          </a>
        ) : (
          <Button size="xs" variant="outline" onClick={handleCopy}>
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "Copied" : "Copy reference"}
          </Button>
        )}
      </div>
    </div>
  )
}
