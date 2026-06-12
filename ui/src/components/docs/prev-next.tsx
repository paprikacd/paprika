import Link from "next/link"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface NavItem {
  label: string
  href: string
}

export function PrevNext({
  prev,
  next,
}: {
  prev?: NavItem | null
  next?: NavItem | null
}) {
  return (
    <div className="mt-12 flex items-center justify-between border-t border-border/50 pt-6">
      <div>
        {prev && (
          <Link
            href={prev.href}
            className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
            {prev.label}
          </Link>
        )}
      </div>
      <div>
        {next && (
          <Link
            href={next.href}
            className="group inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {next.label}
            <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>
    </div>
  )
}
