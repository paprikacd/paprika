"use client"

import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { GammaButton } from "./gamma/button"
import styles from "./insights.module.css"

/**
 * Holds the focused editor's footprint while its chunk loads, at the sizes editor.module.css uses: the 76px header,
 * the preview column and the settings column. The live preview is already on screen, so it is rendered here too and
 * stays where it was instead of blanking the view. Back to dashboard works while the editor loads.
 */
export function WidgetEditorSkeleton({ preview, onClose }: { preview: ReactNode; onClose?: () => void }) {
  return (
    <section className={styles.editorSkeleton} aria-busy="true" aria-label="Widget editor">
      <header className={styles.editorSkeletonHeader}>
        {onClose && (
          <GammaButton variant="quiet" size="sm" onClick={onClose}>
            <ArrowLeft size={16} aria-hidden="true" /><span>Back to dashboard</span>
          </GammaButton>
        )}
        <p role="status">Loading editor…</p>
        <span className={styles.skeletonBar} aria-hidden="true" />
      </header>
      <div className={styles.editorSkeletonBody}>
        <div className={styles.editorSkeletonMain}>
          <div className={styles.editorSkeletonPreview}>
            <div className={styles.editorSkeletonPreviewHeading} aria-hidden="true">
              <span className={styles.skeletonBar} />
            </div>
            <div className={styles.editorSkeletonPreviewCanvas} data-skeleton-preview="">{preview}</div>
          </div>
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
