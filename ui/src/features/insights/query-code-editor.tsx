"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state"
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, tooltips } from "@codemirror/view"
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language"
import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { linter, lintGutter } from "@codemirror/lint"
import type { SQLConfig } from "@codemirror/lang-sql"
import { tags } from "@lezer/highlight"
import type { InsightsClient } from "./client"
import type { DataKind, Provider } from "./schema"
import { inheritGammaTheme } from "./gamma/inherit-theme"
import { createQueryLanguage, providerQueryLanguage, queryDiagnostics, queryLanguageNames, type QueryEditorParameter, type QueryLanguage } from "./query-editor-language"
import { readSQLQuery, sqlQueryIssue, writeSQLQuery, type SQLQueryDraft } from "./query-sql-envelope"
import styles from "./query-code-editor.module.css"

const externalUpdate = Annotation.define<boolean>()
const noParameters: readonly QueryEditorParameter[] = []
const syntaxColors = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--gamma-accent)" },
  { tag: [tags.function(tags.variableName), tags.operatorKeyword], color: "var(--gamma-chart-2, #587caf)" },
  { tag: [tags.string, tags.regexp], color: "var(--gamma-success, #448362)" },
  { tag: [tags.number, tags.bool], color: "var(--gamma-chart-4, #a87540)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--gamma-chart-2, #587caf)" },
  { tag: tags.comment, color: "var(--gamma-muted)", fontStyle: "italic" },
  { tag: tags.special(tags.variableName), color: "var(--gamma-accent)" },
])

function inheritedDisabled(element: HTMLElement): boolean {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLFieldSetElement && parent.disabled) {
      const legend = [...parent.children].find(child => child.tagName === "LEGEND")
      if (!legend?.contains(element)) return true
    }
  }
  return false
}

export interface QueryCodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: QueryLanguage
  provider?: Provider
  providerId?: string
  kind?: DataKind
  client?: InsightsClient
  parameters?: readonly QueryEditorParameter[]
  /** Optional host-supplied SQL schema completion. PostgreSQL is the default dialect. */
  sqlConfig?: SQLConfig
  label?: string
  disabled?: boolean
  className?: string
  onValidityChange?: (valid: boolean) => void
}

export function QueryCodeEditor(props: QueryCodeEditorProps) {
  const language = props.language ?? providerQueryLanguage(props.provider, props.kind)
  return language === "sql" && props.provider?.type === "postgresql"
    ? <SQLQueryEditor {...props} />
    : <PlainQueryCodeEditor {...props} language={language} />
}

function SQLQueryEditor(props: QueryCodeEditorProps) {
  const { value, onChange, parameters = noParameters, onValidityChange, disabled, kind } = props
  const [draft, setDraft] = useState(() => readSQLQuery(value, parameters))
  const emitted = useRef(value)
  const issue = sqlQueryIssue(draft, parameters, kind === "records")
  useEffect(() => { onValidityChange?.(!issue) }, [issue, onValidityChange])
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value
      setDraft(readSQLQuery(value, parameters))
    }
  }, [value, parameters])
  function update(patch: Partial<SQLQueryDraft>) {
    const next = { ...draft, ...patch }
    const source = writeSQLQuery(next)
    emitted.current = source
    setDraft(next)
    onValidityChange?.(!sqlQueryIssue(next, parameters, kind === "records"))
    onChange(source)
  }
  if (draft.raw !== undefined) return <div>
    <PlainQueryCodeEditor {...props} language="json" label="SQL query envelope" onValidityChange={undefined} onChange={source => {
      emitted.current = source
      setDraft(readSQLQuery(source, parameters))
      onChange(source)
    }} />
    <p className={styles.notice} role="alert">{issue}</p>
  </div>
  return <div className={styles.sqlEditor}>
    <PlainQueryCodeEditor {...props} language="sql" parameters={noParameters} onValidityChange={undefined} value={draft.sql} onChange={sql => update({ sql })} />
    <div className={styles.sqlTools}>
      <div><span className={styles.bindingLabel}>Bound parameters</span>
        <PlainQueryCodeEditor value={draft.parameters} language="json" label="SQL parameters" parameters={parameters} disabled={disabled} className={styles.bindingEditor} onChange={parameters => update({ parameters, envelope: true })} />
      </div>
      {(kind !== "records" || draft.projection.trim()) && <div><span className={styles.bindingLabel}>Metric projection (optional)</span>
        <PlainQueryCodeEditor value={draft.projection} language="json" label="SQL metric projection" disabled={disabled} className={styles.bindingEditor} onChange={projection => update({ projection, envelope: true })} />
      </div>}
    </div>
    <p className={styles.notice}>Use <code>$1</code>, <code>$2</code> in SQL and ordered values such as <code>{"[{{service}}, 30]"}</code> below. Values are bound separately; keep placeholders out of SQL.</p>
    <p className={styles.notice}>To bind the selected time range, use <code>{'{"range":"start"}'}</code> and <code>{'{"range":"end"}'}</code> as parameter values. Compare them with timestamp columns in SQL.</p>
    {issue && <p className={styles.syntaxIssue} role="alert">{issue}</p>}
  </div>
}

function PlainQueryCodeEditor({ value, onChange, language: requestedLanguage, provider, providerId, kind, client, parameters = noParameters, sqlConfig, label, disabled = false, className = "", onValidityChange }: QueryCodeEditorProps) {
  const language = requestedLanguage ?? providerQueryLanguage(provider, kind)
  const name = queryLanguageNames[language]
  const accessibleLabel = label ?? `${name} query`
  const helpId = useId()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ value, onChange, disabled, accessibleLabel, onValidityChange, language, parameters })
  useLayoutEffect(() => { latest.current = { value, onChange, disabled, accessibleLabel, onValidityChange, language, parameters } }, [value, onChange, disabled, accessibleLabel, onValidityChange, language, parameters])
  const editable = useRef(new Compartment())
  const languageConfig = useRef(new Compartment())
  const accessibility = useRef(new Compartment())
  const languageCleanup = useRef<(() => void) | undefined>(undefined)
  const [discoveryStatus, setDiscoveryStatus] = useState("")
  const [syntaxStatus, setSyntaxStatus] = useState("")
  const [limitReached, setLimitReached] = useState(false)
  const parameterKey = JSON.stringify(parameters)

  useEffect(() => {
    const element = host.current!
    const portal = document.createElement("div")
    portal.className = styles.portal
    ;(element.closest("dialog[open]") ?? document.body).appendChild(portal)
    const stopTheme = inheritGammaTheme(element, portal)
    const isDisabled = () => latest.current.disabled || inheritedDisabled(element)
    const editability = (): Extension => [EditorState.readOnly.of(isDisabled()), EditorView.editable.of(!isDisabled())]
    const attributes = () => EditorView.contentAttributes.of({ role: "textbox", "aria-label": latest.current.accessibleLabel, "aria-multiline": "true", "aria-describedby": helpId, "aria-disabled": String(isDisabled()), spellcheck: "false", autocapitalize: "off", autocorrect: "off" })
    const editor = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(), lintGutter(),
          EditorView.lineWrapping,
          tooltips({ parent: portal, position: "fixed" }),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 60, icons: true, interactionDelay: 0 }),
          keymap.of([
            { key: "Tab", run: current => completionStatus(current.state) === "active" && acceptCompletion(current) },
            { key: "Escape", run: current => closeCompletion(current) },
            ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
          ]),
          syntaxHighlighting(syntaxColors),
          editable.current.of(editability()), accessibility.current.of(attributes()), languageConfig.current.of([]),
          EditorState.transactionFilter.of(transaction => {
            if (!transaction.docChanged || transaction.annotation(externalUpdate)) return transaction
            if (isDisabled()) return []
            if (transaction.newDoc.length > 8192) { setLimitReached(true); return [] }
            return transaction
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalUpdate))) {
              setLimitReached(false)
              const source = update.state.doc.toString()
              latest.current.onValidityChange?.(!queryDiagnostics(latest.current.language, source, latest.current.parameters).length)
              latest.current.onChange(source)
            }
          }),
        ],
      }),
    })
    view.current = editor
    const observer = new MutationObserver(() => {
      if (isDisabled()) closeCompletion(editor)
      editor.dispatch({ effects: [editable.current.reconfigure(editability()), accessibility.current.reconfigure(attributes())] })
    })
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLFieldSetElement) observer.observe(parent, { attributes: true, attributeFilter: ["disabled"] })
    }
    return () => { observer.disconnect(); languageCleanup.current?.(); editor.destroy(); view.current = null; stopTheme(); portal.remove() }
  }, [helpId])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    languageCleanup.current?.()
    let active = true
    const parsedParameters: QueryEditorParameter[] = JSON.parse(parameterKey)
    const configuration = createQueryLanguage({ language, providerId: providerId ?? provider?.id ?? "", providerType: provider?.type, client, parameters: parsedParameters, sqlConfig, onDiscoveryStatus: status => { if (active) setDiscoveryStatus(status) } })
    setDiscoveryStatus("")
    const validate = (text: string) => {
      const diagnostics = queryDiagnostics(language, text, parsedParameters)
      if (active) {
        setSyntaxStatus(diagnostics.length ? `${diagnostics.length} syntax ${diagnostics.length === 1 ? "issue" : "issues"}: ${diagnostics[0].message}` : language === "sql" ? "SQL language completion" : text.trim() ? "Syntax checked" : "Ready to write a query")
        latest.current.onValidityChange?.(!diagnostics.length)
      }
      return diagnostics
    }
    validate(editor.state.doc.toString())
    editor.dispatch({ effects: languageConfig.current.reconfigure([
      configuration.extensions,
      linter(current => validate(current.state.doc.toString()), { delay: 350 }),
    ]) })
    languageCleanup.current = () => { active = false; configuration.destroy() }
    return languageCleanup.current
  }, [language, provider?.id, provider?.type, providerId, client, parameterKey, sqlConfig])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalUpdate.of(true) })
    setLimitReached(false)
  }, [value])

  useEffect(() => {
    const editor = view.current
    if (!editor || !host.current) return
    const unavailable = disabled || inheritedDisabled(host.current)
    if (unavailable) closeCompletion(editor)
    editor.dispatch({ effects: [
      editable.current.reconfigure([EditorState.readOnly.of(unavailable), EditorView.editable.of(!unavailable)]),
      accessibility.current.reconfigure(EditorView.contentAttributes.of({ role: "textbox", "aria-label": accessibleLabel, "aria-multiline": "true", "aria-describedby": helpId, "aria-disabled": String(unavailable), spellcheck: "false", autocapitalize: "off", autocorrect: "off" })),
    ] })
  }, [disabled, accessibleLabel, helpId])

  return <div className={`${styles.editor} ${className}`} data-query-code-editor data-language={language}>
    <div className={styles.surface} ref={host} />
    <div className={styles.footer}>
      <span role="status" aria-label="Query syntax status" className={syntaxStatus.includes("syntax issue") ? styles.syntaxIssue : undefined}>{syntaxStatus}</span>
      <span id={helpId} className={styles.shortcut}>Ctrl Space to complete · Tab to accept</span>
    </div>
    {(limitReached || discoveryStatus) && <p className={styles.notice} role="status">{limitReached ? "Queries can contain up to 8,192 characters. The last edit was not applied." : discoveryStatus}</p>}
  </div>
}
