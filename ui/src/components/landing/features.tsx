"use client"

import { motion } from "framer-motion"
import {
  Layers,
  GitBranch,
  Split,
  Globe,
  Shield,
  BarChart3,
} from "lucide-react"

const features = [
  {
    icon: Layers,
    title: "Unified Resource Model",
    description:
      "Replace ArgoCD, Rollouts, and Workflows with a single Application CRD. One operator, one resource model, one consistent API. No more stitching together three projects with different conventions.",
    highlight: "3 tools → 1 CRD",
  },
  {
    icon: GitBranch,
    title: "Progressive Delivery",
    description:
      "Canary and blue-green deployments with configurable step weights. Traffic shifts gradually with health verification at every step. Roll back automatically if error rates spike.",
    highlight: "Automated rollbacks",
  },
  {
    icon: Split,
    title: "Pluggable Traffic Routing",
    description:
      "Built-in support for Istio VirtualServices and Gateway API HTTPRoutes. Per-stage traffic router configuration gives you fine-grained control over how traffic reaches your canaries.",
    highlight: "Istio + Gateway API",
  },
  {
    icon: Globe,
    title: "Multi-Cluster by Default",
    description:
      "Stage-level cluster references let you deploy to different clusters per environment. No pre-configured cluster secrets required. Each stage can target a different Kubernetes cluster.",
    highlight: "Any cluster, per stage",
  },
  {
    icon: Shield,
    title: "CEL Health Verification",
    description:
      "Health checks evaluate every resource at every stage using Common Expression Language. Built-in resource health rules, approval gates, and automated rollback on failure.",
    highlight: "Verify before promote",
  },
  {
    icon: BarChart3,
    title: "Real-time Dashboard",
    description:
      "Live visibility into pipelines, releases, stages, and applications. Connect-RPC API for programmatic access. Server-sent events push updates so you never miss a state change.",
    highlight: "Live via SSE",
  },
]

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.06 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const },
  },
}

export function Features() {
  return (
    <section className="border-b border-border/40 py-24">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <motion.p
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-primary"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] as const }}
          >
            Why Paprika
          </motion.p>
          <motion.h2
            className="text-2xl font-semibold tracking-tight sm:text-3xl text-balance"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.05, ease: [0.25, 1, 0.5, 1] as const }}
          >
            Everything You Need for{" "}
            <span className="text-primary">Application Delivery</span>
          </motion.h2>
          <motion.p
            className="mt-3 text-sm text-muted-foreground text-pretty"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.25, 1, 0.5, 1] as const }}
          >
            Paprika consolidates the tools your team needs into a single operator —
            no more stitching together Argo projects with different UIs and upgrade cycles.
          </motion.p>
        </div>

        <motion.div
          className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
        >
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={itemVariants}
              className="group relative rounded-xl border border-border/40 bg-card p-6 transition-all hover:border-primary/25 hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08] text-primary">
                  <feature.icon className="size-5" aria-hidden="true" />
                </span>
                <span className="shrink-0 rounded-md bg-primary/[0.06] px-2 py-0.5 text-[11px] font-medium text-primary/80">
                  {feature.highlight}
                </span>
              </div>
              <h3 className="mt-4 text-sm font-semibold">{feature.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
