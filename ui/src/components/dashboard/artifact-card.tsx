"use client"

import { useState } from "react"
import {
  Check,
  Copy,
  Download,
  FileText,
  FlaskConical,
  Package,
  Paperclip,
} from "lucide-react"

import type { ArtifactRef } from "@/gen/paprika/v1/api_pb"
import { StatusPill } from "@/components/ui/status-chip"
import { buttonVariants } from "@/components/ui/button"
import { copyToClipboard } from "@/lib/clipboard"
import type { StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The kind glyph. Written as a component rather than a returned component
 * reference so React sees one stable type per branch.
 */
function ArtifactIcon({ artifact }: { artifact: ArtifactRef }) {
  const className = "size-3.5 flex-none text-steel-700"
  const kind = artifact.kind.toLowerCase()
  if (kind.includes("oci") || kind.includes("image")) {
    return <Package aria-hidden className={className} />
  }
  if (/junit|test|report/i.test(artifact.name)) {
    return <FlaskConical aria-hidden className={className} />
  }
  if (kind.includes("config") || kind.includes("json") || kind.includes("file")) {
    return <FileText aria-hidden className={className} />
  }
  return <Paperclip aria-hidden className={className} />
}

function artifactTone(phase: string): StatusTone {
  switch (phase) {
    case "Ready":
    case "Succeeded":
      return "healthy"
    case "Failed":
      return "failed"
    case "Pending":
      return "pending"
    default:
      return "unknown"
  }
}

function truncateDigest(digest: string): string {
  if (!digest) return ""
  return digest.length <= 18 ? digest : `${digest.slice(0, 18)}…`
}

function formatCreatedAt(ts: bigint): string {
  const ms = Number(ts) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return ""
  return new Date(ms).toLocaleString()
}

function refToCopy(artifact: ArtifactRef): string {
  return artifact.resolvedReference || artifact.reference || artifact.name
}

interface ArtifactCardProps {
  artifact: ArtifactRef
  /**
   * Optional download URL (e.g. a base64 JSON data URI for ConfigMap
   * artifacts under the size limit). When present, a download link replaces
   * the copy-reference control.
   */
  downloadUrl?: string
  /**
   * Extra provenance the artifact message cannot carry — test counts, sizes.
   * Only ever passed by a caller that has checked its DataState.
   */
  extraMeta?: string
  className?: string
}

/**
 * One artifact, as a row in the artifacts board: kind glyph, identity, state.
 *
 * The reference — not the Kubernetes object name — is the headline, because
 * the reference is what an operator pastes somewhere. The name stays in the
 * meta line so the link back to the manifest is not lost.
 */
export function ArtifactCard({
  artifact,
  downloadUrl,
  extraMeta,
  className,
}: ArtifactCardProps) {
  const [copied, setCopied] = useState(false)
  const reference = refToCopy(artifact)
  const title = reference || artifact.name

  const meta = [
    title === artifact.name ? "" : artifact.name,
    artifact.kind,
    extraMeta ?? "",
    truncateDigest(artifact.digest),
    formatCreatedAt(artifact.createdAt),
  ].filter(Boolean)

  async function handleCopy() {
    try {
      await copyToClipboard(reference)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable; the reference is still on screen.
    }
  }

  return (
    <li
      className={cn(
        "flex items-center gap-2.5 border-b border-rule-soft px-3 py-2",
        className
      )}
    >
      <ArtifactIcon artifact={artifact} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-note">{title}</p>
        {meta.length > 0 ? (
          <p className="truncate text-meta text-neutral-600">
            {meta.join(" · ")}
          </p>
        ) : null}
        {artifact.phase === "Failed" && artifact.failedReason ? (
          <p className="mt-0.5 text-meta text-status-failed-text">
            {artifact.failedReason}
          </p>
        ) : null}
      </div>

      {downloadUrl ? (
        <a
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-xs" }),
            "relative flex-none after:absolute after:-inset-2.5 after:content-['']"
          )}
          href={downloadUrl}
          download={`${artifact.name}.json`}
          aria-label={`Download ${artifact.name}`}
        >
          <Download aria-hidden />
        </a>
      ) : (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy reference for ${artifact.name}`}
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-xs" }),
            "relative flex-none after:absolute after:-inset-2.5 after:content-['']"
          )}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </button>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? `Reference for ${artifact.name} copied` : ""}
      </span>

      {artifact.phase ? (
        <StatusPill
          tone={artifactTone(artifact.phase)}
          label={artifact.phase}
          className="flex-none"
        />
      ) : null}
    </li>
  )
}
