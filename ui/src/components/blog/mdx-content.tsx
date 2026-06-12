import { MDXRemote } from "next-mdx-remote/rsc"
import remarkGfm from "remark-gfm"
import rehypeSlug from "rehype-slug"
import { useMDXComponents } from "./mdx-components"

export function MDXContent({ source }: { source: string }) {
  return (
    <MDXRemote
      source={source}
      components={useMDXComponents()}
      options={{
        mdxOptions: {
          remarkPlugins: [remarkGfm],
          rehypePlugins: [rehypeSlug],
        },
      }}
    />
  )
}
