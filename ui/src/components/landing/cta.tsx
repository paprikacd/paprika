"use client"

import { motion } from "framer-motion"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

export function CTA() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.08] via-primary/[0.03] to-transparent px-8 py-16 text-center sm:px-16"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] as const }}
        >
          <div className="absolute left-1/2 top-0 -translate-x-1/2 size-[32rem] rounded-full bg-primary/[0.04] blur-3xl" />

          <div className="relative">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to Simplify Your{" "}
              <span className="text-primary">Application Delivery</span>?
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
              Paprika is early-stage and looking for early adopters.
              Deploy the operator on your cluster, open an issue on GitHub,
              or just star the repo to follow along.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/login"
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.97]"
              >
                Get Started
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                href="https://github.com/paprikacd/paprika"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border/60 bg-card px-5 text-sm font-medium transition-all hover:bg-secondary active:scale-[0.97]"
              >
                Star on GitHub
              </Link>
            </div>
          </div>
        </motion.div>

        <motion.p
          className="mt-6 text-center text-xs text-muted-foreground"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          Apache 2.0 License. No telemetry. No vendor lock-in.
        </motion.p>
      </div>
    </section>
  )
}
