"use client"

import { useRef } from "react"
import Link from "next/link"
import { motion, useScroll, useTransform } from "framer-motion"
import { ArrowRight, BookOpen, GitBranch } from "lucide-react"
import { PipelineVisualization } from "./pipeline-visualization"

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: [0.25, 1, 0.5, 1] as const },
})

export function Hero() {
  const ref = useRef(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  })
  const bgY = useTransform(scrollYProgress, [0, 1], ["0%", "30%"])
  const opacity = useTransform(scrollYProgress, [0, 0.6], [1, 0])

  return (
    <section ref={ref} className="relative overflow-hidden border-b border-border/40">
      {/* Parallax background */}
      <motion.div className="absolute inset-0" style={{ y: bgY }}>
        <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.06] via-transparent to-transparent" />
        <div className="absolute left-1/2 top-0 -translate-x-1/2 size-[48rem] rounded-full bg-primary/[0.03] blur-3xl" />
      </motion.div>

      <motion.div className="relative mx-auto max-w-7xl px-6 py-24 lg:py-32" style={{ opacity }}>
        <div className="mx-auto max-w-3xl text-center">
          <motion.div {...fadeUp(0)}>
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.06] px-4 py-1 text-xs font-medium text-primary">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              v0.1.0 — First release
            </span>
          </motion.div>

          <motion.h1
            className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl leading-[1.1]"
            {...fadeUp(0.1)}
          >
            One Operator to{" "}
            <span className="text-primary">Replace ArgoCD,<br />Rollouts &amp; Workflows</span>
          </motion.h1>

          <motion.p
            className="mt-5 text-base leading-relaxed text-muted-foreground sm:text-lg max-w-2xl mx-auto"
            {...fadeUp(0.2)}
          >
            Paprika consolidates CI/CD pipelines, progressive delivery, traffic routing,
            and multi-cluster management into a single Kubernetes operator.
            One resource model. One API. One dashboard.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
            {...fadeUp(0.3)}
          >
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
              <GitBranch className="size-4" aria-hidden="true" />
              Star on GitHub
            </Link>
          </motion.div>
        </div>

        <motion.div
          className="mx-auto mt-16 max-w-4xl"
          initial={{ opacity: 0, y: 40 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.4, ease: [0.25, 1, 0.5, 1] as const }}
        >
          <div className="rounded-xl border border-border/30 bg-card/[0.3] p-3 shadow-lg shadow-black/5 backdrop-blur-sm">
            <PipelineVisualization />
          </div>
        </motion.div>
      </motion.div>
    </section>
  )
}
