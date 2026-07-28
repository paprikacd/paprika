import { Boxes, Layers, Rocket } from "lucide-react"

const scopeSegments = [
  { label: "Projects", value: "All projects", icon: Layers },
  { label: "Clusters", value: "All clusters", icon: Boxes },
  { label: "Stages", value: "All stages", icon: Rocket },
]

export function ScopeBar() {
  return (
    <section
      aria-label="Current fleet scope"
      className="sticky top-14 z-30 border-b border-border bg-card lg:top-0"
    >
      <div className="flex min-h-12 items-stretch overflow-x-auto px-4 sm:px-6">
        <div className="flex shrink-0 items-center border-r border-border pr-4">
          <span className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.16em] text-primary">
            Fleet scope
          </span>
        </div>
        {scopeSegments.map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="flex shrink-0 items-center gap-2 border-r border-border px-4 last:border-r-0"
          >
            <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">{label}: </span>
            <span className="text-xs font-medium text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
