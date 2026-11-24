import { validTimestamp } from "../widget-context";
import type { Series, Point } from "../chart-data";

export function latestPoint(
  series: Series,
): (Point & { value: number }) | undefined {
  let latest: (Point & { value: number }) | undefined;
  for (const point of series.points) {
    if (
      typeof point.value === "number" &&
      Number.isFinite(point.value) &&
      validTimestamp(point.timestamp) &&
      (!latest || point.timestamp >= latest.timestamp)
    )
      latest = { ...point, value: point.value };
  }
  return latest;
}

/**
 * The newest point with a valid timestamp, whatever its value (a status or gauge reads the raw value, a missing one
 * included). A later point wins a timestamp tie.
 */
export function latestRaw<P extends { timestamp: number }>(points: readonly P[]): P | undefined {
  let latest: P | undefined;
  for (const point of points) {
    if (validTimestamp(point.timestamp) && (!latest || point.timestamp >= latest.timestamp)) latest = point;
  }
  return latest;
}
