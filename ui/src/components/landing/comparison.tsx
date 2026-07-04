"use client"

import { motion } from "framer-motion"
import { Check, X, ArrowRight } from "lucide-react"
import Link from "next/link"

const comparisons = [
  { feature: "Unified resource model", paprika: true, argo: false },
  { feature: "Single operator binary", paprika: true, argo: false },
  { feature: "Built-in CI/CD pipelines", paprika: true, argo: "Workflows only" },
  { feature: "Canary deployments", paprika: true, argo: "Rollouts only" },
  { feature: "Traffic routing (Istio/Gateway API)", paprika: true, argo: "Rollouts only" },
  { feature: "Multi-cluster stages", paprika: true, argo: "Via ArgoCD only" },
  { feature: "CEL health checks", paprika: true, argo: false },
  { feature: "Approval gates", paprika: true, argo: "Workflows only" },
  { feature: "Real-time dashboard", paprika: true, argo: "Per-project" },
  { feature: "SSE live updates", paprika: true, argo: false },
]

export function Comparison() {
  return (
    <section className="border-b border-border/40 py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <motion.p
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-primary"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] as const }}
          >
            The Comparison
          </motion.p>
          <motion.h2
            className="text-2xl font-semibold tracking-tight sm:text-3xl text-balance"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.05, ease: [0.25, 1, 0.5, 1] as const }}
          >
            One Platform vs{" "}
            <span className="text-muted-foreground">Three Separate Tools</span>
          </motion.h2>
          <motion.p
            className="mt-3 text-sm text-muted-foreground text-pretty"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.25, 1, 0.5, 1] as const }}
          >
            ArgoCD, Argo Rollouts, and Argo Workflows each have their own CRDs, controllers,
            UIs, and upgrade cycles. Paprika replaces all three with one cohesive operator.
          </motion.p>
        </div>

        <motion.div
          className="mt-10 overflow-hidden rounded-xl border border-border/40"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] as const }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40">
                <th className="px-5 py-3.5 text-left text-xs font-semibold text-muted-foreground">Feature</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-primary w-28">Paprika</th>
                <th className="px-5 py-3.5 text-center text-xs font-semibold text-muted-foreground/60 w-40">ArgoCD + Rollouts + Workflows</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((row, i) => (
                <motion.tr
                  key={row.feature}
                  className="border-b border-border/20 last:border-0"
                  initial={{ opacity: 0, x: -8 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.3, delay: i * 0.03 }}
                >
                  <td className="px-5 py-3 text-xs">{row.feature}</td>
                  <td className="px-5 py-3 text-center">
                    {row.paprika === true ? (
                      <span className="inline-flex items-center justify-center size-6 rounded-full bg-success/10 text-success">
                        <Check className="size-3.5" />
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center size-6 rounded-full bg-destructive/10 text-destructive">
                        <X className="size-3.5" />
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-center">
                    {row.argo === true ? (
                      <span className="inline-flex items-center justify-center size-6 rounded-full bg-success/10 text-success">
                        <Check className="size-3.5" />
                      </span>
                    ) : row.argo === false ? (
                      <span className="inline-flex items-center justify-center size-6 rounded-full bg-destructive/10 text-destructive">
                        <X className="size-3.5" />
                      </span>
                    ) : (
                      <span className="text-xs italic text-muted-foreground/60">{row.argo}</span>
                    )}
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </motion.div>

        <motion.div
          className="mt-8 text-center"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <Link
            href="/login"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.97]"
          >
            Try Paprika <ArrowRight className="size-4" />
          </Link>
        </motion.div>
      </div>
    </section>
  )
}
