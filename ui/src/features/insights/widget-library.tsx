import { useState } from "react"
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Grid2X2,
  LineChart,
  ListTree,
  Plus,
  Puzzle,
  Search,
  Sparkles,
  Table2,
  X,
} from "lucide-react"
import { useWidgetDefinitions, type WidgetDefinition } from "./widget-registry"
import styles from "./insights.module.css"
import tools from "./workspace-tools.module.css"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"

const icons = {
  timeseries: LineChart,
  bar: BarChart3,
  stat: Activity,
  table: Table2,
  traces: ListTree,
  heatmap: Grid2X2,
  plugin: Puzzle,
}

export function WidgetLibrary({
  onAdd,
  onClose,
  onAI,
  disabled,
}: {
  onAdd: (definition: WidgetDefinition) => void
  onClose: () => void
  onAI: () => void
  disabled: boolean
}) {
  const definitions = useWidgetDefinitions()
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState<"all" | "metrics" | "traces" | "plugins">("all")
  const visible = definitions.filter(
    (item) =>
      (category === "all" ||
        (category === "plugins" ? item.type === "plugin" : item.dataKind === category)) &&
      `${item.label} ${item.description}`.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <section className={styles.inspector} aria-label="Widget library">
      <div className={styles.panelHeading}>
        <div>
          <span className={styles.eyebrow}>WIDGET LIBRARY</span>
          <h2>Find your perspective</h2>
        </div>
        <GammaButton iconOnly size="sm" variant="quiet" className={styles.iconButton} aria-label="Close widget library" onClick={onClose}>
          <X size={18} />
        </GammaButton>
      </div>
      <p className={styles.muted}>
        Every widget has its own query, data source, and display settings.
      </p>
      <label className={`${styles.search} ${tools.librarySearch}`}>
        <Search size={13} />
        <GammaInput
          aria-label="Search widgets"
          placeholder="Find a visualization"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className={tools.categoryTabs} aria-label="Widget categories">
        {(["all", "metrics", "traces", "plugins"] as const).map((value) => (
          <GammaButton size="sm" variant="quiet" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>
            {value[0].toUpperCase() + value.slice(1)}
          </GammaButton>
        ))}
      </div>
      <div className={styles.widgetLibrary}>
        {visible.map((definition) => {
          const Icon = icons[definition.type]
          return (
            <GammaButton size="sm" variant="quiet" key={definition.id} disabled={disabled} onClick={() => onAdd(definition)}>
              <Icon size={23} strokeWidth={1.5} />
              <div>
                <strong>{definition.label}</strong>
                <span>{definition.description}</span>
              </div>
              <Plus size={15} />
            </GammaButton>
          )
        })}
      </div>
      {!visible.length && (
        <p className={styles.hint}>No widgets match. Try another category or search.</p>
      )}
      {category === "plugins" && (
        <p className={styles.hint}>
          Plugins are installed by your application team. Their settings travel with your dashboard.
        </p>
      )}
      <GammaButton size="sm" variant="quiet" className={styles.aiSuggestion} onClick={onAI}>
        <Sparkles size={17} />
        <div>
          <strong>Start with an idea</strong>
          <span>Build with your AI assistant</span>
        </div>
        <ArrowUpRight size={16} />
      </GammaButton>
    </section>
  )
}
