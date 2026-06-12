import fs from "fs"
import path from "path"
import matter from "gray-matter"

const BLOG_DIR = path.join(process.cwd(), "content", "blog")

export interface BlogPostMeta {
  slug: string
  title: string
  description: string
  date: string
  author: string
  tags: string[]
  image?: string
}

export interface BlogPost extends BlogPostMeta {
  content: string
}

export function getAllPosts(): BlogPostMeta[] {
  const slugs = fs
    .readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const posts: BlogPostMeta[] = []
  for (const slug of slugs) {
    const filePath = path.join(BLOG_DIR, slug, "index.mdx")
    if (!fs.existsSync(filePath)) continue
    const source = fs.readFileSync(filePath, "utf8")
    const { data } = matter(source)
    posts.push({
      slug,
      title: data.title || slug,
      description: data.description || "",
      date: data.date || "",
      author: data.author || "",
      tags: data.tags || [],
      image: data.image,
    })
  }

  return posts.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0
    const tb = b.date ? new Date(b.date).getTime() : 0
    if (isNaN(ta) && isNaN(tb)) return 0
    if (isNaN(ta)) return 1
    if (isNaN(tb)) return -1
    return tb - ta
  })
}

export function getPost(slug: string): BlogPost | null {
  const filePath = path.join(BLOG_DIR, slug, "index.mdx")
  if (!fs.existsSync(filePath)) return null
  const source = fs.readFileSync(filePath, "utf8")
  const { data, content } = matter(source)
  return {
    slug,
    title: data.title || slug,
    description: data.description || "",
    date: data.date || "",
    author: data.author || "",
    tags: data.tags || [],
    image: data.image,
    content,
  }
}

export function getAllSlugs(): string[] {
  return fs
    .readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}
