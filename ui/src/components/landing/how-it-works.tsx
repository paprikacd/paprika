"use client"

import { motion } from "framer-motion"
import { FileCode2, Rocket, CheckCircle2 } from "lucide-react"

const steps = [
  {
    icon: FileCode2,
    title: "Define Your Application",
    description:
      "Create an Application resource that references your Helm chart, Git repo, or S3 bucket. Specify build steps, stages, and deployment strategy in a single YAML manifest.",
    code: `apiVersion: pipelines.papriko.io/v1alpha1
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
      "Paprika renders manifests using Helm SDK, runs pipeline steps as Kubernetes Jobs, and promotes releases through stages — each with its own cluster, canary config, and traffic routing.",
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
      "Health checks evaluate every resource at each stage. Traffic routing shifts weights gradually. Approval gates pause for manual verification. Paprika handles the rest.",
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
    transition: { staggerChildren: 0.2 },
  },
}

const stepVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.5, ease: "easeOut" as const },
  },
}

export function HowItWorks() {
  return (
    <section className="border-b border-border/50 py-20">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            How It Works
          </h2>
          <p className="mt-3 text-muted-foreground">
            From source code to production — in three steps.
          </p>
        </div>

        <motion.div
          className="mt-12 space-y-12"
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
              {/* Connector line */}
              {i < steps.length - 1 && (
                <div className="absolute left-6 top-14 hidden h-[calc(100%+1rem)] w-px bg-gradient-to-b from-primary/30 to-transparent md:block" />
              )}

              <div className="flex flex-col gap-6 md:flex-row md:items-start">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/5">
                  <step.icon className="size-5 text-primary" aria-hidden="true" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-primary">
                      Step {i + 1}
                    </span>
                    <h3 className="text-lg font-semibold">{step.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {step.description}
                  </p>
                </div>

                <div className="w-full shrink-0 md:w-80">
                  <pre className="overflow-x-auto rounded-lg border border-border/50 bg-muted p-4 text-xs leading-relaxed">
                    <code>{step.code}</code>
                  </pre>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
