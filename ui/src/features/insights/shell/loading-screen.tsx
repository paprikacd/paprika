import { Loader2 } from "lucide-react"
import styles from "../insights.module.css"
import gammaTheme from "../gamma/gamma-theme.module.css"
import type { Shell } from "./types"

export function renderLoadingScreen(
  resolvedTheme: Shell["resolvedTheme"],
) {
  return (
    <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
      <div className={styles.loading} role="status">
        <Loader2 className={styles.spin} size={24} /> Opening your workspace…
      </div>
    </div>
  )
}
