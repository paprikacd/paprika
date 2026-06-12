import type { Metadata } from "next"
import { DocsSidebar } from "@/components/docs/sidebar"

export const metadata: Metadata = {
  title: {
    template: "%s | Paprika Docs",
    default: "Documentation",
  },
}

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-7xl">
      <DocsSidebar currentPath="" />
      <div className="min-w-0 flex-1 px-8 py-8">
        <div className="prose prose-sm prose-invert max-w-none
          prose-headings:scroll-mt-20 prose-headings:font-semibold
          prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
          prose-a:text-primary prose-a:no-underline hover:prose-a:underline
          prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-sm prose-code:font-normal
          prose-pre:rounded-lg prose-pre:bg-muted prose-pre:border prose-pre:border-border/50
          prose-img:rounded-lg
          prose-strong:text-foreground
          prose-ul:list-disc prose-li:marker:text-muted-foreground
        ">
          {children}
        </div>
      </div>
    </div>
  )
}
