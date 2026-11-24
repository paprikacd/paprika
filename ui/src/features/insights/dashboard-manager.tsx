// The dashboard settings panel. It opens on request, so it loads then rather than with the first view.
import { lazy, Suspense, useId, useState } from "react";
import { Copy, Download, Settings2, Trash2, X } from "lucide-react";
import { dashboardSchema, type Dashboard, type Provider } from "./schema";
import {
  buildDashboardBundle,
  downloadDocument,
  serializeDashboardBundle,
} from "./workspace-transfer";
import {
  PortableImportPanel,
  type PortableImportProps,
} from "./portable-import-panel";
import { useSavedQueryLibrary } from "./saved-query-context";
import styles from "./dashboard-manager.module.css";
import shared from "./insights.module.css";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { SearchCombobox } from "./gamma/search-combobox";
import type { VariableSourceCatalog } from "./variable-source-editor";

// Loaded on demand: the declarations editor is only needed while a dashboard is managed.
const DashboardVariablesEditor = lazy(() => import("./dashboard-variables-editor").then((module) => ({ default: module.DashboardVariablesEditor })));

const DETAIL_FIELDS = ["title", "folder", "description"] as const;
type DetailField = (typeof DETAIL_FIELDS)[number];
type DetailErrors = Partial<Record<DetailField, string>>;
/** Undo steps for typing in one field merge while they stay in the same group. */
const detailGroups: Record<DetailField, string> = {
  title: "manage:title",
  folder: "manage:folder",
  description: "manage:description",
};

/** The three editable details as text, where a missing folder or description is "". */
function detailFields(item: Pick<Dashboard, "title" | "folder" | "description">) {
  return {
    title: item.title,
    folder: item.folder ?? "",
    description: item.description ?? "",
  };
}

/** Folder text as the schema stores it: each segment trimmed, and "" means the workspace root. */
function normalizeFolder(value: string) {
  return (
    value
      .split("/")
      .map((part) => part.trim())
      .join("/") || undefined
  );
}

/**
 * A folder typed up to a "/" with no name after it yet, such as "Ops/" on the way to "Ops/Pay". It is pending, not an
 * error, until the field loses focus.
 */
function pendingFolder(value: string) {
  const parts = value.split("/");
  return parts.length > 1 && parts[parts.length - 1].trim() === "";
}

/** The text a field's value is stored as, for comparing what was typed with the draft. */
function normalizeDetail(field: DetailField, value: string) {
  if (field === "title") return value.trim();
  if (field === "folder") return normalizeFolder(value) ?? "";
  return value;
}

export function DashboardManager({
  dashboard,
  dashboards,
  providers,
  onApply,
  onDetailsChange,
  onDetailsEnd,
  onDuplicate,
  onDelete,
  onImportBundle,
  onRefreshQueries,
  onReviewBundle,
  validateDocument,
  variableCatalog,
  onClose,
  busy,
}: {
  dashboard: Dashboard;
  dashboards: Dashboard[];
  providers: Provider[];
  variableCatalog?: VariableSourceCatalog;
  busy: boolean;
  onApply: (dashboard: Dashboard) => void;
  /** A valid edit to the name, folder or description. The host writes it to the draft as one undo group. */
  onDetailsChange: (dashboard: Dashboard, group: string) => void;
  /** The field lost focus, so the next edit starts a new undo step. */
  onDetailsEnd: () => void;
  onDuplicate: () => void;
  onDelete: () => Promise<void>;
  onImportBundle: NonNullable<PortableImportProps["onImportBundle"]>;
  onRefreshQueries?: PortableImportProps["onRefreshQueries"];
  onReviewBundle?: PortableImportProps["onReviewBundle"];
  validateDocument?: PortableImportProps["validateDocument"];
  onClose: () => void;
}) {
  const library = useSavedQueryLibrary();
  const [importing, setImporting] = useState(false);
  // The fields hold what was typed. A valid value goes to the draft as it is typed. An invalid one shows its
  // error, and the draft keeps the last valid value.
  const draftDetails = detailFields(dashboard);
  const [fields, setFields] = useState(draftDetails);
  const [fieldErrors, setFieldErrors] = useState<DetailErrors>({});
  const [seenDetails, setSeenDetails] = useState(draftDetails);
  if (JSON.stringify(draftDetails) !== JSON.stringify(seenDetails)) {
    // The draft changed outside these fields, by undo or the header title. A field that already holds the draft's
    // value keeps its text, so a folder typed with a trailing slash is not rewritten under the cursor.
    setSeenDetails(draftDetails);
    const next = { ...fields };
    const errors = { ...fieldErrors };
    for (const key of DETAIL_FIELDS) {
      if (normalizeDetail(key, fields[key]) !== draftDetails[key]) {
        next[key] = draftDetails[key];
        delete errors[key];
      }
    }
    setFields(next);
    setFieldErrors(errors);
  }
  // An error is announced to assistive technology only once its field has lost focus. While typing it is shown
  // without role="alert", so each keystroke does not interrupt the speaker.
  const [announced, setAnnounced] = useState<Partial<Record<DetailField, boolean>>>({});
  // A field's edit while typing ("settle" false) or its blur ("settle" true), when the text is final.
  function editDetail(field: DetailField, raw: string, settle = false) {
    setFields((current) => ({ ...current, [field]: raw }));
    if (field === "folder" && !settle && pendingFolder(raw)) {
      setFieldErrors((current) => {
        const next = { ...current };
        delete next.folder;
        return next;
      });
      setAnnounced((current) => ({ ...current, folder: false }));
      return;
    }
    const value =
      field === "folder"
        ? normalizeFolder(raw)
        : field === "description"
          ? raw || undefined
          : raw;
    const result = dashboardSchema.safeParse({ ...dashboard, [field]: value });
    if (!result.success) {
      const message =
        field === "title" && !raw.trim()
          ? "Enter a name for this dashboard."
          : (result.error.issues[0]?.message ?? "This value is not valid.");
      setFieldErrors((current) => ({ ...current, [field]: message }));
      setAnnounced((current) => ({ ...current, [field]: settle }));
      return;
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setAnnounced((current) => ({ ...current, [field]: false }));
    const parsed = detailFields(result.data);
    if (parsed[field] === draftDetails[field]) return;
    onDetailsChange(result.data, detailGroups[field]);
  }
  const [error, setError] = useState("");
  const foldersId = useId();
  const folderOptions = [
    ...new Set(
      dashboards
        .map((item) => item.folder)
        .filter((value): value is string => !!value),
    ),
  ];
  const exportUsesLibrary = dashboards.some((document) =>
    document.widgets.some(
      (widget) =>
        widget.queryRef ||
        widget.options?.tooltipView?.source?.type === "saved",
    ),
  );
  return (
    <section className={styles.manager} aria-label="Manage dashboards">
      <div className={shared.panelHeading}>
        <h2>
          <Settings2 size={17} /> Manage dashboards
        </h2>
        <GammaButton
          iconOnly
          size="sm"
          variant="quiet"
          className={shared.iconButton}
          aria-label="Close dashboard manager"
          disabled={busy || importing}
          onClick={onClose}
        >
          <X size={18} />
        </GammaButton>
      </div>
      <section onBlur={() => onDetailsEnd()}>
        <label>
          Name
          <GammaInput
            value={fields.title}
            maxLength={120}
            aria-invalid={fieldErrors.title ? true : undefined}
            onChange={(event) => editDetail("title", event.target.value)}
            onBlur={(event) => editDetail("title", event.currentTarget.value, true)}
          />
        </label>
        {fieldErrors.title && (
          <p className={shared.validationError} role={announced.title ? "alert" : undefined}>
            {fieldErrors.title}
          </p>
        )}
        <label htmlFor={foldersId}>
          Folder
          <SearchCombobox
            id={foldersId}
            aria-label="Folder"
            placeholder="e.g. Production / Payments"
            value={fields.folder}
            query={fields.folder}
            maxLength={160}
            aria-invalid={fieldErrors.folder ? true : undefined}
            // Typing drives the draft. onQueryChange is not used: the combobox also clears its query after a pick,
            // and that clear would write an empty folder over the picked one.
            onQueryInput={(value) => editDetail("folder", value)}
            // A pick is an explicit commit, so it settles: a pending "Ops/" shows and announces its error at once.
            onValueChange={(value) => editDetail("folder", value ?? "", true)}
            onBlur={(event) => editDetail("folder", event.currentTarget.value, true)}
            options={[
              ...folderOptions.map((value) => ({ value, label: value })),
              ...(fields.folder && !folderOptions.includes(fields.folder)
                ? [
                    {
                      value: fields.folder,
                      label: fields.folder,
                      description: "Use this folder",
                    },
                  ]
                : []),
            ]}
          />
        </label>
        {fieldErrors.folder && (
          <p className={shared.validationError} role={announced.folder ? "alert" : undefined}>
            {fieldErrors.folder}
          </p>
        )}
        <p>
          Use / for nested folders. Leave empty for the workspace root. Folders
          travel with your dashboard documents.
        </p>
        <label>
          Description
          <GammaTextarea
            aria-label="Description"
            className={styles.description}
            value={fields.description}
            maxLength={500}
            aria-invalid={fieldErrors.description ? true : undefined}
            onChange={(event) => editDetail("description", event.target.value)}
            onBlur={(event) => editDetail("description", event.currentTarget.value, true)}
          />
        </label>
        {fieldErrors.description && (
          <p className={shared.validationError} role={announced.description ? "alert" : undefined}>
            {fieldErrors.description}
          </p>
        )}
        <p className={shared.hint}>
          Changes join the dashboard draft as you type. Save the dashboard to keep them.
        </p>
        <div className={styles.row}>
          <GammaButton
            size="sm"
            variant="secondary"
            className={shared.secondary}
            disabled={busy}
            onClick={onDuplicate}
          >
            <Copy size={13} /> Duplicate
          </GammaButton>
          <GammaButton
            size="sm"
            variant="danger"
            className={styles.danger}
            disabled={
              busy || !dashboards.some((item) => item.id === dashboard.id)
            }
            onClick={onDelete}
          >
            <Trash2 size={13} /> Delete dashboard
          </GammaButton>
        </div>
      </section>
      <Suspense fallback={null}>
        <DashboardVariablesEditor
          key={dashboard.id}
          dashboard={dashboard}
          onApply={onApply}
          catalog={variableCatalog}
        />
      </Suspense>
      <section>
        <h3>Export your library</h3>
        <p>
          Download saved dashboards with every referenced saved query, folders,
          layouts, and widget styles. Provider credentials stay in this
          workspace.
        </p>
        <div className={styles.row}>
          {(["yaml", "json"] as const).map((type) => (
            <GammaButton
              size="sm"
              variant="secondary"
              key={type}
              className={shared.secondary}
              disabled={
                !dashboards.length ||
                (exportUsesLibrary && (!!library.loading || !!library.error))
              }
              onClick={() => {
                try {
                  downloadDocument(
                    serializeDashboardBundle(
                      buildDashboardBundle(dashboards, library.queries),
                      type,
                    ),
                    "paprika-dashboards",
                    type,
                  );
                  setError("");
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Could not export the dashboard library.",
                  );
                }
              }}
            >
              <Download size={13} /> {type.toUpperCase()}
            </GammaButton>
          ))}
        </div>
        {exportUsesLibrary && (library.loading || library.error) && (
          <p>
            {library.loading
              ? "Loading saved queries before export…"
              : `Export needs the saved query library: ${library.error}`}
          </p>
        )}
      </section>
      <PortableImportPanel
        providers={providers}
        validateDocument={validateDocument}
        onBusyChange={setImporting}
        onRefreshQueries={onRefreshQueries}
        onReviewBundle={onReviewBundle}
        onImportBundle={onImportBundle}
      />
      {error && (
        <p role="alert" className={shared.validationError}>
          {error}
        </p>
      )}
    </section>
  );
}
