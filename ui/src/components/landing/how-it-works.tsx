"use client"

import { motion } from "framer-motion"
import { FileCode2, Rocket, CheckCircle2 } from "lucide-react"

const steps = [
  {
    icon: FileCode2,
    title: "Define Your Application",
    description:
      "Create a single Application resource that references your Helm chart, Git repo, or S3 bucket. Specify build steps, stages, and deployment strategy in one manifest. Paprika handles the rest.",
    code: `apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
spec:
  source:
    git:
      url: https://github.com/example/app
      revision: main
  strategy: Canary`,
  },
  {
    icon: Rocket,
    title: "Promote Through Stages",
    description:
      "Paprika renders manifests using the Helm SDK, runs pipeline steps as Kubernetes Jobs, and promotes releases through stages. Each stage supports its own canary config, traffic routing, and cluster target.",
    code: `  stages:
    - name: staging
      canary:
        steps:
          - weight: 10
          - weight: 50
          - weight: 100
    - name: production
      gates:
        - name: approve
          type: ManualApproval`,
  },
  {
    icon: CheckCircle2,
    title: "Verify and Release",
    description:
      "Health checks evaluate every resource at each stage. Traffic routing shifts weights gradually. Approval gates pause for manual verification. If checks fail, Paprika rolls back automatically.",
    code: `  stages:
    - name: production
      trafficRouter:
        istio:
          virtualService: my-app
          host: app.example.com`,
  },
]

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.15 },
  },
}

const stepVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.5, ease: [0.25, 1, 0.5, 1] as const },
  },
}

export function HowItWorks() {
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
            How It Works
          </motion.p>
          <motion.h2
            className="text-2xl font-semibold tracking-tight sm:text-3xl text-balance"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.05, ease: [0.25, 1, 0.5, 1] as const }}
          >
            From Source to Production in Three Steps
          </motion.h2>
          <motion.p
            className="mt-3 text-sm text-muted-foreground text-pretty"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.25, 1, 0.5, 1] as const }}
          >
            Define, promote, verify — Paprika handles rendering, traffic routing, and
            health checking so you don&apos;t have to.
          </motion.p>
        </div>

        <motion.div
          className="mt-12 space-y-16"
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-50px" }}
        >
          {steps.map((step, i) => (
            <motion.div
              key={step.title}
              variants={stepVariants}
              className="relative"
            >
              {/* Connector */}
              {i < steps.length - 1 && (
                <div className="absolute left-5 top-14 hidden h-[calc(100%+2rem)] w-px bg-gradient-to-b from-primary/20 to-transparent md:block" />
              )}

              <div className="flex flex-col gap-6 md:flex-row md:items-start">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/[0.06]">
                  <step.icon className="size-4 text-primary" aria-hidden="true" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-primary/70">
                      Step {i + 1}
                    </span>
                    <h3 className="text-base font-semibold">{step.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-lg">
                    {step.description}
                  </p>
                </div>

                <div className="w-full shrink-0 md:w-80">
                  <div className="overflow-x-auto rounded-lg border border-border/40 bg-card p-4">
                    <pre className="text-[11px] leading-relaxed font-mono text-foreground/80">
                      <code>{step.code}</code>
                    </pre>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
