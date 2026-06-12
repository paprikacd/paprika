import type { MDXComponents } from "mdx/types"
import { Callout } from "./callout"
import Link from "next/link"

function H1({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h1 id={id} className="scroll-mt-20 text-2xl font-semibold tracking-tight mt-8 mb-4 text-foreground">
      {id ? <HeadingAnchor id={id}>{children}</HeadingAnchor> : children}
    </h1>
  )
}

function H2({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-20 text-xl font-semibold tracking-tight mt-8 mb-3 text-foreground">
      {id ? <HeadingAnchor id={id}>{children}</HeadingAnchor> : children}
    </h2>
  )
}

function H3({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-20 text-lg font-medium mt-6 mb-2 text-foreground">
      {id ? <HeadingAnchor id={id}>{children}</HeadingAnchor> : children}
    </h3>
  )
}

function H4({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h4 id={id} className="scroll-mt-20 text-base font-medium mt-4 mb-2 text-foreground">
      {id ? <HeadingAnchor id={id}>{children}</HeadingAnchor> : children}
    </h4>
  )
}

function HeadingAnchor({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <a href={`#${id}`} className="group no-underline">
      <span className="absolute -ml-5 hidden pr-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:inline">#</span>
      {children}
    </a>
  )
}

export function useMDXComponents(): MDXComponents {
  return {
    h1: ({ id, children }) => <H1 id={id}>{children}</H1>,
    h2: ({ id, children }) => <H2 id={id}>{children}</H2>,
    h3: ({ id, children }) => <H3 id={id}>{children}</H3>,
    h4: ({ id, children }) => <H4 id={id}>{children}</H4>,
    p: ({ children }) => (
      <p className="leading-7 text-muted-foreground [&:not(:first-child)]:mt-4">
        {children}
      </p>
    ),
    a: ({ href, children, ...props }) => {
      const isExternal = href?.startsWith("http")
      if (isExternal) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary transition-all"
            {...props}
          >
            {children}
          </a>
        )
      }
      return (
        <Link
          href={href || "#"}
          className="font-medium text-primary underline underline-offset-2 decoration-primary/30 hover:decoration-primary transition-all"
        >
          {children}
        </Link>
      )
    },
    ul: ({ children }) => (
      <ul className="my-4 ml-6 list-disc space-y-1.5 text-muted-foreground [&>li]:marker:text-muted-foreground/50">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-4 ml-6 list-decimal space-y-1.5 text-muted-foreground [&>li]:marker:text-muted-foreground/50">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="leading-7">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-primary/30 pl-4 italic text-muted-foreground">
        {children}
      </blockquote>
    ),
    code: ({ children, className, ...props }) => {
      const isInline = !className
      if (isInline) {
        return (
          <code
            className="rounded bg-muted px-1.5 py-0.5 text-sm font-normal text-foreground"
            {...props}
          >
            {children}
          </code>
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
    pre: ({ children }) => (
      <div className="my-4 overflow-hidden rounded-lg border border-border/50 bg-muted">
        <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
          {children}
        </pre>
      </div>
    ),
    table: ({ children }) => (
      <div className="my-6 overflow-x-auto rounded-lg border border-border/50">
        <table className="w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="border-b border-border/50 bg-muted/50">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="px-4 py-2 text-left font-medium text-foreground">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-4 py-2 text-muted-foreground">{children}</td>
    ),
    tr: ({ children }) => (
      <tr className="border-b border-border/50 last:border-0 [&:last-child>td]:pb-0">
        {children}
      </tr>
    ),
    hr: () => <hr className="my-8 border-border/50" />,
    img: ({ src, alt, width, height }) => (
      <img
        src={src}
        alt={alt || ""}
        width={width}
        height={height}
        className="my-6 rounded-lg border border-border/50"
      />
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-foreground">{children}</strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    Callout,
  }
}
