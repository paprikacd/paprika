import { BookOpen, ChartNoAxesCombined, GitBranch, Link2, ScrollText, Waypoints, CircleDollarSign } from "lucide-react"
import { DrilldownKind } from "@/gen/paprika/v1/api_pb"

export function operationalLinkBrand(url: string, label: string): "grafana" | "github" | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === "github.com" || host.endsWith(".github.com")) return "github"
    // Self-hosted Grafana commonly uses a custom domain or Cloud Run hostname.
    if (/(^|[.-])grafana([.-]|$)/.test(host) || /\bgrafana\b/i.test(label)) return "grafana"
    if (/\bgithub\b/i.test(label)) return "github"
  } catch { /* Invalid links are filtered by the caller. */ }
}

export function OperationalLinkIcon({ url, label, kind }: { url: string; label: string; kind: DrilldownKind }) {
  const brand = operationalLinkBrand(url, label)
  const Icon = ({ [DrilldownKind.UNSPECIFIED]: Link2, [DrilldownKind.CUSTOM]: Link2, [DrilldownKind.DASHBOARD]: ChartNoAxesCombined, [DrilldownKind.LOGS]: ScrollText,
    [DrilldownKind.TRACES]: Waypoints, [DrilldownKind.RUNBOOK]: BookOpen,
    [DrilldownKind.REPOSITORY]: GitBranch, [DrilldownKind.COST]: CircleDollarSign })[kind] ?? Link2
  return <span className="flex size-7 shrink-0 items-center justify-center rounded border border-rule-soft bg-white text-neutral-700" aria-hidden="true">
    {brand ? (
      // Local vector assets need neither an image optimizer nor a third-party favicon service.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/brands/${brand}.svg`} alt="" width={18} height={18} draggable={false} />
    ) : <Icon size={16} strokeWidth={1.7} />}
  </span>
}
