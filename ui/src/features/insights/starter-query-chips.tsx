"use client"

import { GammaButton } from "./gamma/button"
import type { StarterQuery } from "./widget-registry"
import "./lazy-style-boundary.css?editor"
import editorStyles from "./editor.module.css"

/** One-click starter queries for an empty or default query. Each chip fills the query, and maybe the unit and title. */
export function StarterQueryChips({ starters, onChoose }: {
  starters: readonly StarterQuery[]
  onChoose: (starter: StarterQuery) => void
}) {
  return <div role="group" aria-label="Starter queries" className="grid gap-1.5">
    <p className={editorStyles.hint}>Start from a query. A metric may be missing from this source.</p>
    <div className="flex flex-wrap gap-1.5">
      {starters.map((starter) => <GammaButton key={starter.id} type="button" size="sm" variant="secondary" onClick={() => onChoose(starter)}>
        {starter.label}
      </GammaButton>)}
    </div>
  </div>
}
