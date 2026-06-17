import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowUpFromLine,
  ShieldCheck,
  CheckCheck,
  RotateCcw,
  PauseCircle,
  HeartPulse,
  AlertOctagon,
  Activity,
} from "lucide-react"

const statusConfig: Record<string, { icon: typeof Loader2; className: string }> = {
  Running: {
    icon: Loader2,
    className: "bg-primary/10 text-primary border-primary/20 [&_svg]:animate-spin",
  },
  Succeeded: {
    icon: CheckCircle2,
    className: "bg-success/10 text-success border-success/20",
  },
  Failed: {
    icon: XCircle,
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  Pending: {
    icon: Clock,
    className: "bg-warning/10 text-warning border-warning/20",
  },
  Promoting: {
    icon: ArrowUpFromLine,
    className: "bg-primary/10 text-primary border-primary/20",
  },
  Verifying: {
    icon: ShieldCheck,
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  Complete: {
    icon: CheckCheck,
    className: "bg-success/10 text-success border-success/20",
  },
  RolledBack: {
    icon: RotateCcw,
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  Progressing: {
    icon: Activity,
    className: "bg-primary/10 text-primary border-primary/20 [&_svg]:animate-pulse",
  },
  Paused: {
    icon: PauseCircle,
    className: "bg-warning/10 text-warning border-warning/20",
  },
  Healthy: {
    icon: HeartPulse,
    className: "bg-success/10 text-success border-success/20",
  },
  Degraded: {
    icon: AlertOctagon,
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
}

export function StatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const config = statusConfig[status]
  if (!config) {
    return (
      <Badge className="bg-muted text-muted-foreground border-border/50">
        {status}
      </Badge>
    )
  }
  const Icon = config.icon
  return (
    <Badge className={`gap-1.5 ${config.className}`}>
      <Icon className="size-3" />
      {status}
    </Badge>
  )
}
