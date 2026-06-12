import { AlertTriangle, Info, Lightbulb, XCircle } from "lucide-react"

const styles = {
  info: {
    container: "border-blue-500/30 bg-blue-500/5",
    icon: "text-blue-400",
    Icon: Info,
  },
  warning: {
    container: "border-amber-500/30 bg-amber-500/5",
    icon: "text-amber-400",
    Icon: AlertTriangle,
  },
  error: {
    container: "border-red-500/30 bg-red-500/5",
    icon: "text-red-400",
    Icon: XCircle,
  },
  tip: {
    container: "border-emerald-500/30 bg-emerald-500/5",
    icon: "text-emerald-400",
    Icon: Lightbulb,
  },
}

export function Callout({
  type = "info",
  children,
}: {
  type?: keyof typeof styles
  children: React.ReactNode
}) {
  const s = styles[type]
  const Icon = s.Icon
  return (
    <div
      className={`my-6 flex gap-3 rounded-lg border p-4 ${s.container}`}
    >
      <Icon className={`mt-0.5 size-5 shrink-0 ${s.icon}`} aria-hidden="true" />
      <div className="prose prose-sm prose-invert max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        {children}
      </div>
    </div>
  )
}
