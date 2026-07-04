"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import { ArrowRight, Star, Globe } from "lucide-react"

export function CTA() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-primary/5 via-background to-accent/5 p-12 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          {/* Decorative blurs */}
          <div className="absolute -left-20 -top-20 size-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -bottom-20 -right-20 size-40 rounded-full bg-accent/10 blur-3xl" />

          <div className="relative">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to Simplify Your Deployments?
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-muted-foreground">
              Get started with Paprika in under 5 minutes. Install the operator
              via Helm or Kustomize and create your first Application.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/docs/getting-started"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.96]"
              >
                Get Started
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <a
                href="https://github.com/paprikacd/paprika"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border bg-secondary px-5 py-2.5 text-sm font-medium shadow-[0_0_0_1px_rgba(255,255,255,0.08)] transition-all hover:bg-secondary/80 active:scale-[0.96]"
              >
                <Star className="size-4" aria-hidden="true" />
                Star on GitHub
              </a>
            </div>

            <div className="mt-8 flex items-center justify-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Globe className="size-3.5" aria-hidden="true" />
                Apache 2.0 License
              </span>
              <span className="flex items-center gap-1.5">
                <Star className="size-3.5" />
                Open Source
              </span>
              <span>v0.1.0</span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
