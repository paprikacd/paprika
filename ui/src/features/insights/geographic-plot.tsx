import type { MouseEventHandler, ReactNode } from "react";
import { worldLandPath } from "./plugins/world-land";
import styles from "./geographic-plot.module.css";

/** One fitted WGS84 plane for every record map. Land, grid and observations
 * share the same 2:1 transform; a short panel never crops the southern half. */
export function GeographicPlot({ children, showGrid = false, showCoordinates = false, onClickCapture, density = false }: {
  children: ReactNode;
  showGrid?: boolean;
  showCoordinates?: boolean;
  onClickCapture?: MouseEventHandler<HTMLDivElement>;
  density?: boolean;
}) {
  return <div className={styles.surface} data-geographic-plot="" data-coordinates={showCoordinates || undefined}>
    <div className={styles.plane} data-map-plane="" data-geo-plane="map" data-density={density || undefined} role="group" aria-label="Geographic map · WGS84 equirectangular projection" onClickCapture={onClickCapture}>
      <svg viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <path d={worldLandPath} fillRule="evenodd" className={styles.land} data-geographic-land="natural-earth-110m" />
        {showGrid && [-180, -120, -60, 0, 60, 120, 180].map(lon => <line key={`lon-${lon}`} x1={(lon + 180) * 2} x2={(lon + 180) * 2} y1={0} y2={360} className={styles.grid} />)}
        {showGrid && [-90, -60, -30, 0, 30, 60, 90].map(lat => <line key={`lat-${lat}`} x1={0} x2={720} y1={(90 - lat) * 2} y2={(90 - lat) * 2} className={styles.grid} />)}
      </svg>
      {showCoordinates && <><span className={`${styles.coordinate} ${styles.north}`}>90°N</span><span className={`${styles.coordinate} ${styles.south}`}>90°S</span><span className={`${styles.coordinate} ${styles.west}`}>180°W</span><span className={`${styles.coordinate} ${styles.east}`}>180°E</span><span className={`${styles.coordinate} ${styles.equator}`}>0°</span></>}
      {children}
    </div>
  </div>;
}
