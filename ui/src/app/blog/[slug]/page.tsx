import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, Calendar, Clock } from "lucide-react"
import { getPost, getAllSlugs } from "@/lib/content"
import { MDXContent } from "@/components/blog/mdx-content"
import { TableOfContents } from "@/components/blog/table-of-contents"

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }))
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = getPost(slug)

  if (!post) notFound()

  const headings = extractHeadings(post.content)

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href="/blog"
        className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to blog
      </Link>

      <article>
        <header className="mb-10">
          <div className="flex flex-wrap gap-2 mb-4">
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
              >
                {tag}
              </span>
            ))}
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {post.title}
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">
            {post.description}
          </p>
          <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Calendar className="size-4" aria-hidden="true" />
              {post.date}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="size-4" aria-hidden="true" />
              {post.author}
            </span>
          </div>
        </header>

        <div className="flex gap-12">
          <div className="min-w-0 flex-1">
            <div className="prose prose-sm prose-invert max-w-none
              prose-headings:scroll-mt-20
              prose-p:leading-7 prose-p:text-muted-foreground [&>p:first-child]:mt-0
              prose-a:text-primary prose-a:no-underline hover:prose-a:underline
              prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-sm prose-code:font-normal
              prose-pre:rounded-lg prose-pre:bg-muted prose-pre:border prose-pre:border-border/50
              prose-img:rounded-lg
              prose-strong:text-foreground
            ">
              <MDXContent source={post.content} />
            </div>
          </div>

          {headings.length > 0 && (
            <aside className="hidden w-56 shrink-0 lg:block">
              <div className="sticky top-20">
                <TableOfContents headings={headings} />
              </div>
            </aside>
          )}
        </div>
      </article>
    </div>
  )
}

function extractHeadings(content: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = []
  const headingRegex = /^(#{2,3})\s+(.+)$/gm
  let match
  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length
    const text = match[2].trim()
    const id = text
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
    headings.push({ id, text, level })
  }
  return headings
}
