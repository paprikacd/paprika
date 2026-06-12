"use client"

import { useEffect, useState } from "react"

export function DocTOC() {
  const [activeId, setActiveId] = useState<string>("")
  const [headings, setHeadings] = useState<
    { id: string; text: string; level: number }[]
  >([])

  useEffect(() => {
    const els = Array.from(document.querySelectorAll("h2, h3")).map((el) => ({
      id: el.id || el.textContent?.toLowerCase().replace(/\s+/g, "-") || "",
      text: el.textContent || "",
      level: el.tagName === "H2" ? 2 : 3,
    }))
    setHeadings(els)

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px" },
    )

    for (const h of els) {
      const el = document.getElementById(h.id)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [])

  if (headings.length < 2) return null

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <div className="sticky top-20 overflow-y-auto py-8">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          On this page
        </h4>
        <nav className="space-y-1">
          {headings.map((h) => (
            <a
              key={h.id}
              href={`#${h.id}`}
              className={`block text-sm transition-colors ${
                h.level === 3 ? "pl-4" : ""
              } ${
                activeId === h.id
                  ? "font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {h.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  )
}
