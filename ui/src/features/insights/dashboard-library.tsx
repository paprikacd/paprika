import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  LayoutDashboard,
} from "lucide-react";
import type { Dashboard } from "./schema";
import styles from "./workspace-tools.module.css";
import shared from "./insights.module.css";
import { GammaButton } from "./gamma/button";


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
