"use client"

import { Activity, Boxes, ShieldCheck, TriangleAlert } from "lucide-react"

import { FleetHealth, type GetSystemStatusResponse } from "@/gen/paprika/v1/api_pb"
import styles from "./fleet-signal-strip.module.css"

type Signal = {
  id: "index" | "healthy" | "progressing" | "attention"
  label: string
  meaning: string
  value: bigint | null
  Icon: typeof Activity
}

function countFor(status: GetSystemStatusResponse | undefined, health: FleetHealth): bigint | null {
  if (!status) return null
  return status.health.find(bucket => bucket.health === health)?.count ?? BigInt(0)
}

/**
 * These counters come from GetSystemStatus's whole-fleet index, which does
 * not take the current inventory URL filters. Do not label them scoped,
 * turn missing responses into zero, or invent a synthetic trend.
 */
export function FleetSignalStrip({ status }: { status: GetSystemStatusResponse | undefined }) {
  const signals: readonly Signal[] = [
    { id: "index", label: "Indexed applications", meaning: "Whole-fleet inventory", value: status?.total ?? null, Icon: Boxes },
    { id: "healthy", label: "Healthy", meaning: "Reported healthy", value: countFor(status, FleetHealth.HEALTHY), Icon: ShieldCheck },
    { id: "progressing", label: "Progressing", meaning: "Still converging", value: countFor(status, FleetHealth.PROGRESSING), Icon: Activity },
    { id: "attention", label: "Needs attention", meaning: "Ranked by blast radius", value: status?.attentionTotal ?? null, Icon: TriangleAlert },
  ]

  return (
    <section aria-label="Fleet signals" data-fleet-signal-strip className={styles.surface} aria-busy={!status}>
      <div className={styles.heading}>
        <h2 className={styles.title}>Fleet signals</h2>
        <span className={styles.scope}>Whole-fleet index · counts are not narrowed by view filters</span>
      </div>
      <div className={styles.metrics}>
        {signals.map(({ id, label, meaning, value, Icon }) => (
          <div key={id} data-fleet-signal={id} className={styles.metric}>
            <div className={styles.label}>
              <Icon size={16} strokeWidth={1.7} aria-hidden="true" className={styles.icon} />
              <span>{label}</span>
            </div>
            <div className={styles.number} aria-label={value === null ? label + ": unavailable" : label + ": " + value.toLocaleString("en-AU")}>
              {value === null ? "—" : value.toLocaleString("en-AU")}
            </div>
            <div className={styles.meaning}>{value === null ? "Awaiting fleet index" : meaning}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
