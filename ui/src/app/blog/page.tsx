import Link from "next/link"
import { Calendar, Clock, ArrowRight } from "lucide-react"
import { getAllPosts } from "@/lib/content"

export default function BlogPage() {
  const posts = getAllPosts()

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <div className="mb-12">
        <h1 className="text-3xl font-semibold tracking-tight">Blog</h1>
        <p className="mt-2 text-muted-foreground">
          Updates, tutorials, and deep dives into Paprika and Kubernetes-native delivery.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group rounded-xl border border-border/50 bg-card p-6 transition-all hover:border-primary/30 hover:shadow-sm"
          >
            <div className="flex flex-wrap gap-2 mb-3">
              {post.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                >
                  {tag}
                </span>
              ))}
            </div>
            <h2 className="text-lg font-semibold tracking-tight group-hover:text-primary transition-colors">
              {post.title}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground line-clamp-2">
              {post.description}
            </p>
            <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Calendar className="size-3.5" aria-hidden="true" />
                {post.date}
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="size-3.5" aria-hidden="true" />
                {post.author}
              </span>
            </div>
            <div className="mt-4 flex items-center gap-1 text-sm font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
              Read more <ArrowRight className="size-3.5" aria-hidden="true" />
            </div>
          </Link>
        ))}
      </div>

      {posts.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <p className="text-lg font-medium">No posts yet</p>
          <p className="text-sm text-muted-foreground">
            Check back soon for updates.
          </p>
        </div>
      )}
    </div>
  )
}
