"use client"

import type { ReactNode } from "react"
import styles from "./insights.module.css"

/**
 * Holds the focused editor's footprint while its chunk loads: the 76px header, the preview column and the settings
 * column, at the sizes editor.module.css uses. The live preview is already on screen, so it is rendered here too and
 * stays where it was instead of blanking the view.
 */
export function WidgetEditorSkeleton({ preview }: { preview: ReactNode }) {
  return (
    <section className={styles.editorSkeleton} aria-busy="true" aria-label="Widget editor">
      <header className={styles.editorSkeletonHeader}>
        <p role="status">Loading editor…</p>
        <span className={styles.skeletonBar} aria-hidden="true" />
      </header>
      <div className={styles.editorSkeletonBody}>
        <div className={styles.editorSkeletonMain}>
          <div className={styles.editorSkeletonPreview}>{preview}</div>
          <div className={styles.editorSkeletonQuery} aria-hidden="true">
            <span className={styles.skeletonBar} />
          </div>
        </div>
        <div className={styles.editorSkeletonSettings} aria-hidden="true">
          <span className={styles.skeletonBar} />
          <span className={styles.skeletonBlock} />
        </div>
      </div>
    </section>
  )
}
