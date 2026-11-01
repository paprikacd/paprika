import { useMemo } from 'react';
import { GeoMap } from '../charts/geo/GeoMap';
import type { GeoGeometry, GeoLocation, GeoSeverity } from '../charts/geo/geo-data';
import { EmptyState, ObservationDetails, formatMetric } from '../renderer-extensions/chart-renderers';
import type { WidgetRendererProps } from '../renderer-extensions/widget-registry';
import { buildConnectionMap, connectionMapConfig } from '@insights/plugins/operational-records-data';
import { worldLandPath } from '@insights/plugins/world-land';
import styles from '@insights/plugins/operational-records.module.css';

const geometry: GeoGeometry = {
  width: 720, height: 360, description: 'WGS84 equirectangular projection',
  countries: [{ name: 'Natural Earth land', path: worldLandPath }],
  project: (longitude, latitude) => [(longitude + 180) * 2, (90 - latitude) * 2],
};

/** Color comes from an explicitly supplied classification, not geographic inference. */
export function mapSeverity(status: string): GeoSeverity {
  const value = status.trim().toLowerCase();
  if (value === 'high' || value === 'high risk') return 'high';
  if (value === 'medium' || value === 'medium risk') return 'medium';
  if (value === 'low' || value === 'low risk') return 'low';
  return 'unknown';
}

type Location = ReturnType<typeof buildConnectionMap>['locations'][number];
export function geographicIdentity(location: Location) {
  return location.context.labels?.id || JSON.stringify([location.label, location.latitude, location.longitude]);
}

/** Local renderer extension; retains the upstream parser, adapter and original plugin ID. */
export function ZoomableConnectionMap(props: WidgetRendererProps) {
  const { widget, result, embedded, onContextChange } = props;
  const config = useMemo(() => connectionMapConfig.parse(widget.config ?? {}), [widget.config]);
  const data = useMemo(() => result.records ? buildConnectionMap(result.records, config) : undefined, [result.records, config]);
  const locations = useMemo<GeoLocation[]>(() => data?.locations.map(location => ({
    id: geographicIdentity(location), label: location.label, latitude: location.latitude,
    longitude: location.longitude, value: location.value, severity: mapSeverity(location.status),
  })) ?? [], [data]);
  if (!data) return <EmptyState/>;
  const unit = widget.unit || data.valueUnit;
  const interactive = !embedded && widget.options?.showTooltip !== false;
  const observed = (location: Location) => location.value === null ? 'No observed value' : formatMetric(location.value, unit === 'percent' ? '%' : unit, false, widget.options?.decimals);
  return <div className={`${styles.wrapper} chart-catalog-map`} data-operational-chart="connection-map" data-map-extension="shared-zoom-viewport">
    <GeoMap label={widget.title} locations={locations} geometry={geometry} valueLabel={unit || 'observed value'} interactive={!embedded} inspectable={interactive} detailPresentation="tooltip" maxPoints={config.maxPoints} selectionRevision={result}
      onSelect={location => { const source = location ? data.locations.find(row => geographicIdentity(row) === location.id) : undefined; if (!embedded) onContextChange?.(source?.context ?? {}); }}/>
    {config.showLocations !== false && <div className={styles.locationList} aria-label="Location observations">
      {data.locations.map(location => <ObservationDetails key={geographicIdentity(location)} label={`Inspect location ${location.label}`} className={styles.locationRow} revision={result} enabled={interactive}
        onSelect={interactive && onContextChange ? () => onContextChange(location.context) : undefined}
        details={<div className={styles.details}><strong>{location.label}</strong><span>{location.latitude.toFixed(4)}°, {location.longitude.toFixed(4)}°</span><span>{observed(location)}</span><span>{location.status || 'Classification not supplied'}</span></div>}>
        <span className={styles.name}>{location.label}<small>{location.latitude.toFixed(2)}°, {location.longitude.toFixed(2)}°</small></span>
        {config.value && <span className={styles.value}>{observed(location)}</span>}
        {location.status && <span>{location.status}</span>}
      </ObservationDetails>)}
    </div>}
    <div className={styles.notes} role="status">{widget.options?.showLegend !== false && <><span>Fixed-size presence markers</span><span className="catalog-map-legend" aria-label="Supplied risk classification">{(['low','medium','high','unknown'] as const).map(risk=><span key={risk}><i aria-hidden="true" style={{background:`var(--paprika-map-${risk})`}}/>{risk === 'unknown' ? 'Unclassified' : `${risk[0].toUpperCase()}${risk.slice(1)} risk`}</span>)}</span></>}
      {data.invalid > 0 && <span>{data.invalid} records have missing or invalid coordinates.</span>}
      {data.omitted > 0 && <span>{data.omitted} additional locations omitted by the point limit.</span>}
      {(data.frame.truncated || result.truncated) && <span>Partial result · source limit reached.</span>}
    </div>
  </div>;
}
