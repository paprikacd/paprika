"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import { ArrowRight, GitBranch, BookOpen } from "lucide-react"
import { PipelineVisualization } from "./pipeline-visualization"

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border/50">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />

      <div className="relative mx-auto max-w-7xl px-6 py-20 lg:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              v0.1.0 — First release
            </div>
          </motion.div>

          <motion.h1
            className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            Kubernetes-Native{" "}
            <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Application Delivery
            </span>
          </motion.h1>

          <motion.p
            className="mt-6 text-lg leading-relaxed text-muted-foreground sm:text-xl"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            Paprika replaces ArgoCD, Argo Rollouts, and Argo Workflows with a
            single operator. CI/CD pipelines, progressive delivery, traffic
            routing, and multi-cluster management — unified under one resource
            model.
          </motion.p>

          <motion.div
            className="mt-8 flex flex-wrap items-center justify-center gap-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <Link
              href="/docs/getting-started"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90"
            >
              Get Started
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-5 py-2.5 text-sm font-medium transition-all hover:bg-secondary/80"
            >
              <BookOpen className="size-4" aria-hidden="true" />
              Documentation
            </Link>
            <a
              href="https://github.com/paprikacd/paprika"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium transition-all hover:bg-secondary/80"
            >
              <GitBranch className="size-4" aria-hidden="true" />
              GitHub
            </a>
          </motion.div>
        </div>

        <motion.div
          className="mt-16"
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4 }}
        >
          <div className="rounded-xl border border-border/50 bg-card/50 p-4 backdrop-blur-sm">
            <PipelineVisualization />
          </div>
        </motion.div>
      </div>
    </section>
  )
}
