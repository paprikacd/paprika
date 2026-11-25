import { ArrowUpRight, LineChart, RefreshCw } from "lucide-react"
import { reloadPage } from "../lazy-panel"
import styles from "../insights.module.css"
import { GammaButton } from "../gamma/button"
import gammaTheme from "../gamma/gamma-theme.module.css"
import type { Shell } from "./types"

export function renderUnavailableScreen(
  enterExample: Shell["enterExample"],
  error: Shell["error"],
  exampleStarting: Shell["exampleStarting"],
  resolvedTheme: Shell["resolvedTheme"],
  setMode: Shell["setMode"],
  setRetry: Shell["setRetry"],
  workspaceFailed: Shell["workspaceFailed"],
) {
  return (
    <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
      <div className={styles.setup}>
        <span className={styles.eyebrow}>PAPRIKA / INSIGHTS</span>
        <h1>A clearer view of your stack.</h1>
        <p>
          Build your own observability workspace. Connect Prometheus and
          Tempo, compose widgets, and keep dashboards as code.
        </p>
        <div className={styles.setupPreview}>
          <LineChart size={44} strokeWidth={1} />
          <div>
            <strong>Your signals. Your canvas.</strong>
            <span>Visual editing · JSON & YAML · OpenUI</span>
          </div>
        </div>
        <p role="alert" className={styles.validationError}>
          {error && error.charAt(0).toUpperCase() + error.slice(1)}
        </p>
        {exampleStarting && <p className={styles.hint} role="status">Opening the example workspace…</p>}
        <div className={styles.actions}>
          {workspaceFailed ? (
            <GammaButton size="sm" variant="primary" className={styles.primary} onClick={reloadPage}>
              Reload the page <RefreshCw size={16} />
            </GammaButton>
          ) : (
            <>
              <GammaButton size="sm" variant="primary"
                className={styles.primary}
                disabled={exampleStarting}
                onClick={() => {
                  setMode("loading")
                  setRetry((value) => value + 1)
                }}
              >
                Retry connection
              </GammaButton>
              <GammaButton size="sm" variant="secondary" className={styles.secondary} disabled={exampleStarting} onClick={() => { void enterExample() }}>
                Explore the example <ArrowUpRight size={16} />
              </GammaButton>
            </>
          )}
        </div>
        <p className={styles.hint}>
          Enable the separate Insights service to connect live data and save
          shared dashboards. Example mode uses generated sample data and
          browser storage.
        </p>
      </div>
    </div>
  )
}
