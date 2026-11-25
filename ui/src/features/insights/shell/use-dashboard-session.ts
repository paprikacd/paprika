import { useId, useRef, useState } from "react"
import { type Dashboard, type Widget } from "../schema"
import { exampleDashboard } from "../example"
import { documentFingerprint } from "../fingerprint"
import type { CheckReport } from "@/gen/paprika/insights/v1/checks_pb"
import { type DashboardNavigation } from "../drilldown"
import { useDashboardView } from "../dashboard-view"
import type { AfterSavedQueryLibrary } from "./types"

export function useDashboardSession(
  dashboard: AfterSavedQueryLibrary["dashboard"],
  mode: AfterSavedQueryLibrary["mode"],
) {
  const { current: currentRoute, apply: applyView, reflect: reflectView, show: showView } = useDashboardView(dashboard.id, mode === "example")
  const [returnTo, setReturnTo] = useState<{ state: DashboardNavigation; title: string } | null>(null)
  const [saved, setSaved] = useState(documentFingerprint(exampleDashboard))
  const [editing, setEditing] = useState(false)
  const [widgetDraftValid, setWidgetDraftValid] = useState(true)
  const [widgetPreview, setWidgetPreview] = useState<Widget>()
  const [widgetDraftDirty, setWidgetDraftDirty] = useState(false)
  const widgetOpener = useRef<string | undefined>(undefined)
  const invalidWidgetSaveHintId = useId()
  const [panel, setPanel] = useState<
    "add" | "source" | "ai" | "providers" | "widget" | "manage" | "examples" | "starters" | "history" | null
  >(null)
  const [selected, setSelected] = useState<string>()
  const [message, setMessage] = useState("")
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // An action on the notice, such as Undo after a removal. It shows only while its text is the message on screen.
  // chartEditor marks an action that only works while the chart editor is open, so closing the editor removes it.
  const [messageAction, setMessageAction] = useState<{ text: string; label: string; name: string; run: () => void; document?: Dashboard; chartEditor?: boolean }>()
  // The removal notice describes one document. Once any change moves the dashboard away from it (Undo from the toolbar or
  // the keyboard, or a later edit), the notice and its Undo action are out of date, so both go. This adjusts state while
  // rendering, when the dashboard changes, rather than in an effect.
  const [noticeDashboard, setNoticeDashboard] = useState(dashboard)
  if (noticeDashboard !== dashboard) {
    setNoticeDashboard(dashboard)
    const after = messageAction?.document
    if (after && dashboard !== after && JSON.stringify(dashboard) !== JSON.stringify(after)) {
      if (message === messageAction.text) setMessage("")
      setMessageAction(undefined)
    }
  }
  const [error, setError] = useState("")
  // Findings a rejected save carried. They show only while their error message is the one on screen.
  const [saveFindings, setSaveFindings] = useState<{ message: string; report: CheckReport }>()
  // Link variables this dashboard could not apply. Dismissible; it never blocks the view.
  const [linkNotice, setLinkNotice] = useState("")
  const [remoteDashboard, setRemoteDashboard] = useState<{ id: string; removed: boolean }>()
  const [busy, setBusy] = useState(false)
  const [importingBundle, setImportingBundle] = useState(false)
  return [
    applyView,
    busy,
    currentRoute,
    editing,
    error,
    importingBundle,
    invalidWidgetSaveHintId,
    linkNotice,
    message,
    messageAction,
    panel,
    reflectView,
    remoteDashboard,
    returnTo,
    saveFindings,
    saved,
    selected,
    setBusy,
    setEditing,
    setError,
    setImportingBundle,
    setLinkNotice,
    setMessage,
    setMessageAction,
    setPanel,
    setRemoteDashboard,
    setReturnTo,
    setSaveFindings,
    setSaved,
    setSelected,
    setShortcutsOpen,
    setWidgetDraftDirty,
    setWidgetDraftValid,
    setWidgetPreview,
    shortcutsOpen,
    showView,
    widgetDraftDirty,
    widgetDraftValid,
    widgetOpener,
    widgetPreview,
  ] as const
}
