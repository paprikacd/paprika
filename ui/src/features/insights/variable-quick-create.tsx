"use client"

import { useState } from "react"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { dashboardVariableSchema, MAX_DASHBOARD_VARIABLES, type DashboardVariable } from "./schema"
import styles from "./drilldown.module.css"

/**
 * A small form that declares one dashboard variable from inside another editor. Callers load it with React.lazy, so
 * the form and its CSS stay out of the first view. `onCreate` writes the variable; if it throws, its message is shown.
 */
export default function VariableQuickCreate({ initialName = "", existing, onCreate, onCancel }: {
  initialName?: string
  existing: readonly string[]
  onCreate: (variable: DashboardVariable) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const [label, setLabel] = useState("")
  const [defaultValue, setDefaultValue] = useState("")
  const [choices, setChoices] = useState("")
  const [error, setError] = useState("")

  function submit() {
    const trimmed = name.trim()
    if (!trimmed) return setError("Enter a variable name.")
    if (existing.includes(trimmed)) return setError(`A variable named ${trimmed} already exists.`)
    if (existing.length >= MAX_DASHBOARD_VARIABLES) return setError(`A dashboard supports up to ${MAX_DASHBOARD_VARIABLES} variables.`)
    const options = choices.split(",").map((choice) => choice.trim()).filter(Boolean)
    const candidate: DashboardVariable = {
      name: trimmed,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(defaultValue !== "" ? { defaultValue } : {}),
      ...(options.length ? { options: [...new Set(options)] } : {}),
    }
    const checked = dashboardVariableSchema.safeParse(candidate)
    if (!checked.success) return setError(checked.error.issues[0]?.message ?? "This variable is not valid.")
    try {
      onCreate(checked.data)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The variable could not be declared.")
    }
  }

  return <form className={styles.card} aria-label="New dashboard variable" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <label className={styles.field}><span>Variable name</span>
      <GammaInput aria-label="New variable name" value={name} maxLength={64} placeholder="service" onChange={(event) => setName(event.target.value)} />
    </label>
    <label className={styles.field}><span>Display label <small>Optional</small></span>
      <GammaInput aria-label="New variable display label" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
    </label>
    <label className={styles.field}><span>Default value <small>Optional</small></span>
      <GammaInput aria-label="New variable default value" value={defaultValue} maxLength={256} onChange={(event) => setDefaultValue(event.target.value)} />
    </label>
    <label className={styles.field}><span>Choices <small>Optional, comma separated</small></span>
      <GammaInput aria-label="New variable choices" value={choices} maxLength={1024} placeholder="api, worker" onChange={(event) => setChoices(event.target.value)} />
    </label>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.actions}>
      <GammaButton type="submit" size="sm" variant="primary">Create variable</GammaButton>
      <GammaButton type="button" size="sm" variant="quiet" onClick={onCancel}>Cancel</GammaButton>
    </div>
  </form>
}
