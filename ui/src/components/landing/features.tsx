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
      "Replace ArgoCD, Rollouts, and Workflows with a single Application CRD. One operator, one resource model, one consistent API.",
  },
  {
    icon: GitBranch,
    title: "Progressive Delivery",
    description:
      "Canary and blue-green deployments with configurable step weights. Let traffic shift gradually and verify health at every step.",
  },
  {
    icon: Split,
    title: "Pluggable Traffic Routing",
    description:
      "Built-in support for Istio VirtualServices and Gateway API HTTPRoutes. Per-stage traffic router configuration for fine-grained control.",
  },
  {
    icon: Globe,
    title: "Multi-Cluster by Default",
    description:
      "Stage-level cluster references let you deploy to different clusters per environment. No pre-configured cluster secrets required.",
  },
  {
    icon: Shield,
    title: "Health Verification",
    description:
      "CEL-based health checks, built-in resource health rules, and approval gates ensure deployments are verified at every stage.",
  },
  {
    icon: BarChart3,
    title: "Built-in Dashboard",
    description:
      "Real-time visibility into pipelines, releases, stages, and applications. Connect-RPC API for programmatic access.",
  },
]

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
}

export function Features() {
  return (
    <section className="border-b border-border/50 py-20">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Everything You Need for{" "}
            <span className="text-primary">Application Delivery</span>
          </h2>
          <p className="mt-3 text-muted-foreground">
            Paprika consolidates the tools your team needs into a single
            operator — no more stitching together Argo projects.
          </p>
        </div>

        <motion.div
          className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
        >
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={itemVariants}
              className="group rounded-xl border border-border/50 bg-card p-6 transition-all hover:border-primary/30 hover:shadow-sm"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
                <feature.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
