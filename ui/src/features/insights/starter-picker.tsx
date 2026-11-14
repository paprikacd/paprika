import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, LayoutTemplate, X } from "lucide-react";
import type { StarterSummary } from "./client";
import {
  PortableImportPanel,
  type PortableImportProps,
} from "./portable-import-panel";
import {
  serializeDashboardBundle,
  type DashboardBundle,
} from "./workspace-transfer";
import { GammaButton } from "./gamma/button";
import shared from "./insights.module.css";
import styles from "./starter-picker.module.css";

export interface StarterPickerProps extends PortableImportProps {
  listStarters: (signal?: AbortSignal) => Promise<StarterSummary[]>;
  getStarter: (id: string, signal?: AbortSignal) => Promise<DashboardBundle>;
  onClose: () => void;
}

interface ChosenStarter {
  id: string;
  source: string;
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

// A thumbnail keeps its grid proportions and is never taller than this, so a tall
// template is narrower rather than squashed.
const THUMBNAIL_MAX_HEIGHT = 140;

/** A schematic of the starter's grid: each widget is a rectangle at its layout. */
export function StarterThumbnail({ tiles }: { tiles: StarterSummary["tiles"] }) {
  const rows = Math.max(1, ...tiles.map((tile) => tile.y + tile.h));
  return (
    <div
      className={styles.thumbnail}
      style={{
        aspectRatio: `12 / ${rows}`,
        maxWidth: `${Math.round((THUMBNAIL_MAX_HEIGHT * 12) / rows)}px`,
      }}
      aria-hidden="true"
      data-testid="starter-thumbnail"
    >
      {tiles.map((tile, index) => (
        <span
          key={index}
          data-tile={tile.type}
          className={styles.tile}
          style={{
            left: `${(tile.x / 12) * 100}%`,
            top: `${(tile.y / rows) * 100}%`,
            width: `${(tile.w / 12) * 100}%`,
            height: `${(tile.h / rows) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Starts a dashboard from a first-party starter. Choosing one loads its portable
 * bundle and hands it to the same import review a file goes through, so nothing is
 * saved until the user confirms the import there.
 */
export function StarterPicker({
  listStarters,
  getStarter,
  onClose,
  onBusyChange,
  ...importProps
}: StarterPickerProps) {
  const [starters, setStarters] = useState<StarterSummary[]>();
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [chosen, setChosen] = useState<ChosenStarter>();
  const [loadError, setLoadError] = useState("");
  const [importing, setImporting] = useState(false);
  const idBase = useId();
  // The heading stays mounted in every view, so focus lands on it when a card or
  // "All templates" removes the element that had focus.
  const heading = useRef<HTMLHeadingElement>(null);
  // The latest request wins: a bundle that arrives after the user chose another starter is dropped.
  const generation = useRef(0);
  const loaders = useRef({ listStarters, getStarter });
  useEffect(() => {
    loaders.current = { listStarters, getStarter };
  });
  useEffect(() => {
    const controller = new AbortController();
    loaders.current.listStarters(controller.signal).then(
      (value) => setStarters(value),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setListError(messageOf(error, "Templates are unavailable."));
      },
    );
    return () => controller.abort();
  }, []);

  function choose(id: string) {
    const current = ++generation.current;
    setSelected(id);
    setChosen(undefined);
    setLoadError("");
    heading.current?.focus();
    loaders.current.getStarter(id).then(
      (bundle) => {
        if (current !== generation.current) return;
        setChosen({ id, source: serializeDashboardBundle(bundle, "json") });
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setLoadError(messageOf(error, "This template could not be loaded."));
      },
    );
  }

  function back() {
    generation.current++;
    setSelected(undefined);
    setChosen(undefined);
    setLoadError("");
    heading.current?.focus();
  }

  return (
    <section className={styles.picker} aria-label="Start from a template">
      <div className={shared.panelHeading}>
        <h2 ref={heading} tabIndex={-1} className={styles.heading}>
          <LayoutTemplate size={17} /> Start from a template
        </h2>
        <GammaButton
          iconOnly
          size="sm"
          variant="quiet"
          aria-label="Close templates"
          disabled={importing}
          onClick={onClose}
        >
          <X size={18} />
        </GammaButton>
      </div>
      {selected ? (
        <>
          <GammaButton
            size="sm"
            variant="quiet"
            className={styles.back}
            disabled={importing}
            onClick={back}
          >
            <ArrowLeft size={14} /> All templates
          </GammaButton>
          {chosen?.id === selected ? (
            <PortableImportPanel
              key={chosen.id}
              {...importProps}
              onBusyChange={(value) => {
                setImporting(value);
                onBusyChange?.(value);
              }}
              initialDocument={{ source: chosen.source, format: "json" }}
            />
          ) : loadError ? (
            <p role="alert" className={styles.unavailable}>
              {loadError}
            </p>
          ) : (
            <p role="status" className={styles.loading}>
              Loading template…
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.intro}>
            Each template is a complete dashboard. Choose one, then map its
            providers in the review. Its variables keep their defaults and can
            be changed on the dashboard afterwards. Nothing is saved until you
            confirm.
          </p>
          {listError ? (
            <p role="alert" className={styles.unavailable}>
              {listError}
            </p>
          ) : !starters ? (
            <p role="status" className={styles.loading}>
              Loading templates…
            </p>
          ) : (
            <ul className={styles.list} aria-label="Templates">
              {starters.map((starter, index) => {
                const titleId = `${idBase}-${index}-title`;
                const descriptionId = `${idBase}-${index}-description`;
                const metaId = `${idBase}-${index}-meta`;
                return (
                <li key={starter.id}>
                  <button
                    type="button"
                    className={styles.card}
                    aria-labelledby={titleId}
                    aria-describedby={`${descriptionId} ${metaId}`}
                    onClick={() => choose(starter.id)}
                  >
                    <StarterThumbnail tiles={starter.tiles} />
                    <strong id={titleId}>{starter.title}</strong>
                    <span id={descriptionId} className={styles.description}>
                      {starter.description}
                    </span>
                    <small id={metaId} className={styles.meta}>
                      {starter.widgetCount} widget
                      {starter.widgetCount === 1 ? "" : "s"}
                      {starter.providers.length
                        ? ` · needs ${starter.providers.join(", ")}`
                        : ""}
                      {starter.variables.length
                        ? ` · variables ${starter.variables.join(", ")}`
                        : ""}
                    </small>
                  </button>
                </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
