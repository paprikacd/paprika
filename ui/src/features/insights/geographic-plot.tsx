import { lazy, Suspense, useCallback, useState, type MouseEventHandler, type ReactNode } from "react";
import { LazyPanelBoundary, MountSignal } from "./lazy-panel";
import styles from "./geographic-plot.module.css";

// The 110m land outline is about 60 KB of path data that only map widgets need. A failed chunk drops the outline and
// keeps the grid and observations, since a map without land is still a usable plot.
const loadWorldLand = () => import("./plugins/world-land");
const WorldLandPath = lazy(() => loadWorldLand().then(({ worldLandPath }) => ({
  default: function WorldLandOutline() {
    return <path d={worldLandPath} fillRule="evenodd" className={styles.land} data-geographic-land="natural-earth-110m" />;
  },
})));

type LandStatus = "loading" | "ready" | "failed";

/** Reports when the outline has mounted or failed. The plane stays aria-busy until then, so renderers and e2e wait. */
function WorldLand({ onSettled }: { onSettled: (status: Exclude<LandStatus, "loading">) => void }) {
  const ready = useCallback(() => onSettled("ready"), [onSettled]);
  const failed = useCallback(() => onSettled("failed"), [onSettled]);
  return (
    <LazyPanelBoundary label="World land" renderFailure={() => <MountSignal onMount={failed} />}>
      <Suspense fallback={null}>
        <WorldLandPath />
        <MountSignal onMount={ready} />
      </Suspense>
    </LazyPanelBoundary>
  );
}

/** One fitted WGS84 plane for every record map. Land, grid and observations
 * share the same 2:1 transform; a short panel never crops the southern half. */
export function GeographicPlot({ children, showGrid = false, showCoordinates = false, onClickCapture, density = false }: {
  children: ReactNode;
  showGrid?: boolean;
  showCoordinates?: boolean;
  onClickCapture?: MouseEventHandler<HTMLDivElement>;
  density?: boolean;
}) {
  const [landStatus, setLandStatus] = useState<LandStatus>("loading");
  return <div className={styles.surface} data-geographic-plot="" data-coordinates={showCoordinates || undefined}>
    <div className={styles.plane} data-map-plane="" data-geo-plane="map" data-land-status={landStatus} aria-busy={landStatus === "loading" ? true : undefined} data-density={density || undefined} role="group" aria-label="Geographic map · WGS84 equirectangular projection" onClickCapture={onClickCapture}>
      <svg viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <WorldLand onSettled={setLandStatus} />
        {showGrid && [-180, -120, -60, 0, 60, 120, 180].map(lon => <line key={`lon-${lon}`} x1={(lon + 180) * 2} x2={(lon + 180) * 2} y1={0} y2={360} className={styles.grid} />)}
        {showGrid && [-90, -60, -30, 0, 30, 60, 90].map(lat => <line key={`lat-${lat}`} x1={0} x2={720} y1={(90 - lat) * 2} y2={(90 - lat) * 2} className={styles.grid} />)}
      </svg>
      {showCoordinates && <><span className={`${styles.coordinate} ${styles.north}`}>90°N</span><span className={`${styles.coordinate} ${styles.south}`}>90°S</span><span className={`${styles.coordinate} ${styles.west}`}>180°W</span><span className={`${styles.coordinate} ${styles.east}`}>180°E</span><span className={`${styles.coordinate} ${styles.equator}`}>0°</span></>}
      {children}
    </div>
  </div>;
}
