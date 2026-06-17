import Link from "next/link"

const sidebarSections = [
  {
    title: "Getting Started",
    items: [
      { label: "Overview", href: "/docs" },
      { label: "Quickstart", href: "/docs/getting-started" },
    ],
  },
  {
    title: "Concepts",
    items: [
      { label: "Application", href: "/docs/concepts/application" },
      { label: "Template", href: "/docs/concepts/template" },
      { label: "Pipeline", href: "/docs/concepts/pipeline" },
      { label: "Stage", href: "/docs/concepts/stage" },
      { label: "Release", href: "/docs/concepts/release" },
    ],
  },
  {
    title: "Reference",
    items: [
      { label: "CLI", href: "/docs/cli" },
      { label: "CRD Types", href: "/docs/api/types" },
      { label: "RPC Methods", href: "/docs/api/rpc" },
      { label: "Apply & Rollback RPC", href: "/docs/api/apply" },
    ],
  },
]

export function DocsSidebar({ currentPath }: { currentPath: string }) {
  return (
    <aside className="w-64 shrink-0 border-r border-border/50">
      <div className="sticky top-14 overflow-y-auto py-8 pr-4">
        {sidebarSections.map((section) => (
          <div key={section.title} className="mb-6">
            <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {section.title}
            </h3>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = currentPath === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                        isActive
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
