import { useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  LayoutDashboard,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { dashboardSchema, type Dashboard, type Provider } from "./schema";
import {
  buildDashboardBundle,
  downloadDocument,
  remapDashboardProviders,
  serializeDashboardBundle,
} from "./workspace-transfer";
import {
  PortableImportPanel,
  type PortableImportProps,
} from "./portable-import-panel";
import { useSavedQueryLibrary } from "./saved-query-context";
import styles from "./workspace-tools.module.css";
import shared from "./insights.module.css";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { SearchCombobox } from "./gamma/search-combobox";
import { DashboardVariablesEditor } from "./dashboard-variables";

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  dashboards: Dashboard[];
}
export function dashboardTree(
  dashboards: Dashboard[],
  search = "",
): FolderNode {
  const root: FolderNode = {
    name: "Dashboards",
    path: "",
    folders: [],
    dashboards: [],
  };
  for (const dashboard of dashboards) {
    if (
      !`${dashboard.title} ${dashboard.folder ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
      continue;
    let node = root;
    for (const name of dashboard.folder?.split("/") ?? []) {
      let folder = node.folders.find((entry) => entry.name === name);
      if (!folder) {
        folder = {
          name,
          path: node.path ? `${node.path}/${name}` : name,
          folders: [],
          dashboards: [],
        };
        node.folders.push(folder);
      }
      node = folder;
    }
    node.dashboards.push(dashboard);
  }
  function sort(node: FolderNode) {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.dashboards.sort((a, b) => a.title.localeCompare(b.title));
    node.folders.forEach(sort);
  }
  sort(root);
  return root;
}

export function DashboardTree({
  dashboards,
  activeId,
  search,
  onOpen,
  onMove,
}: {
  dashboards: Dashboard[];
  activeId: string;
  search: string;
  onOpen: (dashboard: Dashboard) => void;
  onMove: (id: string, folder?: string) => void;
}) {
  const root = useMemo(
    () => dashboardTree(dashboards, search),
    [dashboards, search],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const navigation = useRef<HTMLElement>(null);
  const pointer = useRef<{
    id: string;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const consumedClick = useRef(false);
  function folderAt(x: number, y: number) {
    const target = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-folder-path]");
    return target && navigation.current?.contains(target)
      ? target.dataset.folderPath
      : undefined;
  }
  function cancelDrag() {
    pointer.current = null;
    setDragging(false);
    setDrop(undefined);
  }
  function render(node: FolderNode) {
    return (
      <ul className={styles.tree}>
        {node.folders.map((folder) => {
          const open = !!search || !collapsed.has(folder.path);
          return (
            <li key={folder.path}>
              <GammaButton
                size="sm"
                variant="quiet"
                aria-expanded={open}
                title={folder.path}
                data-folder-path={folder.path}
                data-drop={drop === folder.path}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(folder.path)) next.delete(folder.path);
                    else next.add(folder.path);
                    return next;
                  })
                }
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Folder size={13} />
                <span>{folder.name}</span>
              </GammaButton>
              {open && render(folder)}
            </li>
          );
        })}
        {node.dashboards.map((dashboard) => (
          <li key={dashboard.id}>
            <GammaButton
              size="sm"
              variant="quiet"
              aria-current={activeId === dashboard.id ? "page" : undefined}
              title={dashboard.title}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.pointerType === "touch") return;
                consumedClick.current = false;
                pointer.current = {
                  id: dashboard.id,
                  x: event.clientX,
                  y: event.clientY,
                  active: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onLostPointerCapture={cancelDrag}
              onClick={(event) => {
                if (consumedClick.current && event.detail > 0) {
                  consumedClick.current = false;
                  return;
                }
                onOpen(dashboard);
              }}
            >
              <LayoutDashboard size={12} />
              <span>{dashboard.title}</span>
            </GammaButton>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <nav
      ref={navigation}
      aria-label="Dashboard library"
      data-dragging={dragging}
      onPointerMove={(event) => {
        const current = pointer.current;
        if (!current) return;
        if (
          !current.active &&
          Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6
        )
          return;
        current.active = true;
        event.preventDefault();
        setDragging(true);
        setDrop(folderAt(event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        const current = pointer.current;
        const folder = folderAt(event.clientX, event.clientY);
        cancelDrag();
        if (current?.active) {
          consumedClick.current = true;
          if (folder !== undefined) onMove(current.id, folder || undefined);
        }
      }}
      onPointerCancel={cancelDrag}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancelDrag();
      }}
    >
      {!!dashboards.length && (
        <div
          className={styles.rootDrop}
          data-folder-path=""
          data-drop={drop === ""}
          title="Drag a dashboard here to move it to the workspace root. Use Manage for keyboard moves."
        >
          Workspace root
        </div>
      )}
      {render(root)}
      {!root.folders.length && !root.dashboards.length && (
        <p className={shared.hint}>
          {search
            ? "No dashboards match your search."
            : "Saved dashboards appear here."}
        </p>
      )}
    </nav>
  );
}

export function DashboardManager({
  dashboard,
  dashboards,
  providers,
  onApply,
  onDuplicate,
  onDelete,
  onImport,
  onImportBundle,
  onRefreshQueries,
  onReviewBundle,
  onClose,
  busy,
}: {
  dashboard: Dashboard;
  dashboards: Dashboard[];
  providers: Provider[];
  busy: boolean;
  onApply: (dashboard: Dashboard) => void;
  onDuplicate: () => void;
  onDelete: () => Promise<void>;
  onImport?: (
    documents: Dashboard[],
  ) => Promise<{ added: number; failed: Dashboard[]; errors: string[] }>;
  onImportBundle?: PortableImportProps["onImportBundle"];
  onRefreshQueries?: PortableImportProps["onRefreshQueries"];
  onReviewBundle?: PortableImportProps["onReviewBundle"];
  onClose: () => void;
}) {
  const library = useSavedQueryLibrary();
  const [importing, setImporting] = useState(false);
  const [title, setTitle] = useState(dashboard.title);
  const [folder, setFolder] = useState(dashboard.folder ?? "");
  const [description, setDescription] = useState(dashboard.description ?? "");
  const [baseDetails, setBaseDetails] = useState(() =>
    JSON.stringify([dashboard.title, dashboard.folder, dashboard.description]),
  );
  const stale =
    baseDetails !==
    JSON.stringify([dashboard.title, dashboard.folder, dashboard.description]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const foldersId = useId();
  const folderOptions = [
    ...new Set(
      dashboards
        .map((item) => item.folder)
        .filter((value): value is string => !!value),
    ),
  ];
  const legacyCompleted = useRef(new Map<string, Set<string>>());
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
      <section>
        {stale && (
          <div className={shared.validationError} role="alert">
            Dashboard details changed while this panel was open.
            <GammaButton
              size="sm"
              variant="secondary"
              className={shared.secondary}
              onClick={() => {
                setTitle(dashboard.title);
                setFolder(dashboard.folder ?? "");
                setDescription(dashboard.description ?? "");
                setBaseDetails(
                  JSON.stringify([
                    dashboard.title,
                    dashboard.folder,
                    dashboard.description,
                  ]),
                );
              }}
            >
              Reload details
            </GammaButton>
          </div>
        )}
        <label>
          Name
          <GammaInput
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label htmlFor={foldersId}>
          Folder
          <SearchCombobox
            id={foldersId}
            aria-label="Folder"
            placeholder="e.g. Production / Payments"
            value={folder}
            query={folder}
            maxLength={160}
            onQueryChange={setFolder}
            onValueChange={(value) => setFolder(value ?? "")}
            options={[
              ...folderOptions.map((value) => ({ value, label: value })),
              ...(folder && !folderOptions.includes(folder)
                ? [
                    {
                      value: folder,
                      label: folder,
                      description: "Use this folder",
                    },
                  ]
                : []),
            ]}
          />
        </label>
        <p>
          Use / for nested folders. Leave empty for the workspace root. Folders
          travel with your dashboard documents.
        </p>
        <label>
          Description
          <GammaTextarea
            aria-label="Description"
            className={styles.description}
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <GammaButton
          size="sm"
          variant="primary"
          className={shared.primary}
          disabled={stale}
          onClick={() => {
            const result = dashboardSchema.safeParse({
              ...dashboard,
              title,
              description,
              folder:
                folder
                  .split("/")
                  .map((part) => part.trim())
                  .join("/") || undefined,
            });
            if (!result.success)
              setError(
                result.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join("\n"),
              );
            else {
              onApply(result.data);
              setBaseDetails(
                JSON.stringify([
                  result.data.title,
                  result.data.folder,
                  result.data.description,
                ]),
              );
              setError("");
              setMessage("Details applied. Save the dashboard to keep them.");
            }
          }}
        >
          Apply dashboard details
        </GammaButton>
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
      <DashboardVariablesEditor
        key={dashboard.id}
        dashboard={dashboard}
        onApply={onApply}
      />
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
        onBusyChange={setImporting}
        onRefreshQueries={onRefreshQueries}
        onReviewBundle={onReviewBundle}
        onImportBundle={
          onImportBundle ??
          (onImport
            ? async (request) => {
                if (request.bundle.savedQueries?.length)
                  throw new Error(
                    "This host must support portable saved queries before this bundle can be imported.",
                  );
                const completed =
                  legacyCompleted.current.get(request.sessionId) ??
                  new Set<string>();
                legacyCompleted.current.set(request.sessionId, completed);
                const documents = request.bundle.dashboards.filter(
                  (document) => !completed.has(document.id),
                );
                const result = await onImport(
                  remapDashboardProviders(
                    documents,
                    request.providerMapping,
                    providers,
                  ),
                );
                const failed = new Set(
                  result.failed.map((document) => document.id),
                );
                documents.forEach((document) => {
                  if (!failed.has(document.id)) completed.add(document.id);
                });
                return {
                  ...result,
                  totalAdded: completed.size,
                  queriesAdded: 0,
                  queriesReused: 0,
                  dashboardsKept: 0,
                  dashboardsReplaced: 0,
                  queriesReplaced: 0,
                  complete: result.failed.length === 0,
                };
              }
            : undefined)
        }
      />
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className={shared.validationError}>
          {error}
        </p>
      )}
    </section>
  );
}
