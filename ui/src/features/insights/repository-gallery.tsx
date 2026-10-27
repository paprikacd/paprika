"use client"

import { useState } from "react"
import { ArrowLeft, BookOpen, Download, X } from "lucide-react"
import {
  PortableImportPanel,
  type PortableImportProps,
} from "./portable-import-panel"
import {
  downloadDocument,
  serializeDashboardBundle,
  type DashboardBundle,
} from "./workspace-transfer"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import styles from "./repository-gallery.module.css"
import shared from "./insights.module.css"

export interface GalleryExample {
  id: string
  title: string
  project: string
  description: string
  source: { revision: string; paths: string[] }
  sample: DashboardBundle
  live?: DashboardBundle
  liveStatus: "ready" | "partial" | "unavailable"
  providers?: PortableImportProps["sourceProviders"]
  limitations: string[]
}

export function RepositoryGallery({
  entries,
  mode,
  onClose,
  ...importProps
}: PortableImportProps & {
  entries: readonly GalleryExample[]
  mode: "live" | "example"
  onClose: () => void
}) {
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const entry = entries.find((item) => item.id === selected)
  const bundle = entry && (mode === "example" ? entry.sample : entry.live)
  const visible = entries.filter((item) =>
    `${item.title} ${item.project} ${item.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <section className={styles.gallery} aria-label="Repository examples">
      <div className={shared.panelHeading}>
        <h2>
          <BookOpen size={17} /> Dashboard examples
        </h2>
        <GammaButton
          iconOnly
          size="sm"
          variant="quiet"
          aria-label="Close examples"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </GammaButton>
      </div>
      {entry ? (
        <>
          <GammaButton
            size="sm"
            variant="quiet"
            className={styles.back}
            disabled={busy}
            onClick={() => setSelected(undefined)}
          >
            <ArrowLeft size={14} /> All examples
          </GammaButton>
          <div className={styles.detail}>
            <span className={styles.project}>{entry.project}</span>
            <h3>{entry.title}</h3>
            <p>{entry.description}</p>
            <p>
              {mode === "example"
                ? "This copy uses labelled sample data in your browser workspace."
                : "Choose your connected providers below. Queries run with your existing access."}
            </p>
            {entry.limitations.length > 0 && (
              <details>
                <summary>Adaptations and data requirements</summary>
                <ul>
                  {entry.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </details>
            )}
            <details>
              <summary>Source provenance</summary>
              <code>{entry.source.revision}</code>
              <ul>
                {entry.source.paths.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
            {bundle && (
              <GammaButton
                size="sm"
                variant="secondary"
                onClick={() =>
                  downloadDocument(
                    serializeDashboardBundle(bundle, "json"),
                    entry.id,
                    "json",
                  )
                }
              >
                <Download size={13} /> Download bundle
              </GammaButton>
            )}
          </div>
          {bundle ? (
            <PortableImportPanel
              key={`${entry.id}-${mode}`}
              {...importProps}
              sourceProviders={mode === "live" ? entry.providers : undefined}
              initialDocument={{
                source: serializeDashboardBundle(bundle, "json"),
                format: "json",
              }}
              onBusyChange={(value) => {
                setBusy(value)
                importProps.onBusyChange?.(value)
              }}
            />
          ) : (
            <p className={styles.unavailable}>
              This example needs a source that is not connected through a live
              adapter yet. Open the example workspace to explore the labelled
              sample.
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.intro}>
            Dashboards from Shorted and Uptime, with reusable queries, filters
            and source provenance.{" "}
            {mode === "example"
              ? "Samples stay in this browser."
              : "Import a live template and connect your data sources."}
          </p>
          <GammaInput
            aria-label="Find an example"
            placeholder="Find a dashboard or project…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className={styles.count}>
            {visible.length} examples ·{" "}
            {mode === "example" ? "sample data" : "live templates"}
          </div>
          <ul className={styles.entries}>
            {visible.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => setSelected(item.id)}>
                  <span className={styles.project}>{item.project}</span>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                  <small>
                    {item.sample.dashboards.length} dashboard
                    {item.sample.dashboards.length === 1 ? "" : "s"} ·{" "}
                    {item.sample.savedQueries?.length ?? 0} saved queries{" "}
                    <em>
                      {item.liveStatus === "ready"
                        ? "Live adapter"
                        : item.liveStatus === "partial"
                          ? "Partial live coverage"
                          : "Sample only"}
                    </em>
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {!visible.length && (
            <p role="status">No examples match this search.</p>
          )}
        </>
      )}
    </section>
  )
}
