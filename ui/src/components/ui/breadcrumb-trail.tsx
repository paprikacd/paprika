import Link from "next/link"

import { cn } from "@/lib/utils"

export interface BreadcrumbTrailItem {
  label: string
  href?: string
}

/**
 * Gamma BreadcrumbTrail, adapted to the console. It wraps rather than
 * clipping, links every ancestor that has a route, and marks only the final
 * crumb as the current page. Project keys contain slashes, so callers encode
 * them when building the href.
 */
export function BreadcrumbTrail({
  items,
  className,
}: {
  items: readonly BreadcrumbTrailItem[]
  className?: string
}) {
  if (items.length === 0) return null

  return (
    <nav
      aria-label="Breadcrumb"
      data-slot="breadcrumb-trail"
      className={cn("font-mono text-meta text-neutral-600", className)}
    >
      <ol className="flex list-none flex-wrap items-center gap-x-1.5 gap-y-1">
        {items.map((item, index) => {
          const current = index === items.length - 1
          return (
            <li
              key={`${item.label}-${index}`}
              className="flex min-w-0 items-center gap-x-1.5"
            >
              {index > 0 ? (
                <span aria-hidden="true" className="text-neutral-400">
                  /
                </span>
              ) : null}
              {item.href && !current ? (
                <Link
                  href={item.href}
                  className="min-w-0 truncate text-steel-700 underline-offset-2 hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={current ? "page" : undefined}
                  className="min-w-0 truncate"
                >
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
