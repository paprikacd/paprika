export const RELIABILITY_TARGET = 0.999;
export const ALLOWED_ERROR_RATIO = 1 - RELIABILITY_TARGET;
export const HOUR_MS = 3_600_000;
export const RELIABILITY_END_MS = Date.UTC(2026, 9, 30, 0);
export type ReliabilityScenario = 'steady' | 'incident' | 'gaps';
export type ReliabilityWindow = 1 | 7 | 30;
export const RELIABILITY_SERVICES = [
  { id: 'payment-api', name: 'Payments', requestsPerHour: 162_000, errorRatio: 0.00072 },
  { id: 'auth-api', name: 'Authentication', requestsPerHour: 245_000, errorRatio: 0.00040 },
  { id: 'catalog-api', name: 'Catalogue', requestsPerHour: 438_000, errorRatio: 0.00012 },
  { id: 'uptime-api', name: 'Uptime', requestsPerHour: 126_000, errorRatio: 0.00034 },
] as const;
export type ReliabilityServiceId = typeof RELIABILITY_SERVICES[number]['id'];
export type ReliabilityScope = ReliabilityServiceId | 'all';
export interface ReliabilityPoint {
  timestampMs: number;
  serviceId: ReliabilityServiceId;
  requests: number | null;
  failures: number | null;
}
export interface ReliabilityDataset {
  startMs: number;
  endMs: number;
  days: ReliabilityWindow;
  scenario: ReliabilityScenario;
  revision: number;
  points: ReliabilityPoint[];
}
export interface ReliabilitySummary {
  requests: number;
  failures: number;
  availability: number | null;
  errorRatio: number | null;
  allowedFailures: number;
  budgetRemaining: number | null;
  observedIntervals: number;
  expectedIntervals: number;
  coverage: number;
}
export interface BurnPoint {
  timestampMs: number;
  requests: number | null;
  failures: number | null;
  oneHour: number | null;
  sixHour: number | null;
  complete: boolean;
}
export interface StateInterval extends ReliabilitySummary {
  startMs: number;
  endMs: number;
  worstHourBurn: number | null;
  state: 'healthy' | 'elevated' | 'breaching' | 'missing';
}
export interface ReliabilityIncident {
  id: string;
  serviceId: ReliabilityServiceId;
  startMs: number;
  endMs: number;
  title: string;
  status: 'Active' | 'Resolved';
}

function serviceMatch(point: ReliabilityPoint, scope: ReliabilityScope) {
  return scope === 'all' || point.serviceId === scope;
}

export function buildReliability(days: ReliabilityWindow = 30, scenario: ReliabilityScenario = 'incident', revision = 0): ReliabilityDataset {
  const endMs = RELIABILITY_END_MS + revision * HOUR_MS;
  const startMs = endMs - days * 24 * HOUR_MS;
  const points: ReliabilityPoint[] = [];
  // Keep exactly five hours of lookback so the first visible six-hour rate is real.
  for (let timestampMs = startMs - 4 * HOUR_MS; timestampMs <= endMs; timestampMs += HOUR_MS) {
    const absoluteHour = Math.floor((timestampMs - RELIABILITY_END_MS) / HOUR_MS);
    // Events belong to absolute time: advancing the snapshot must not rewrite history.
    const hoursBeforeBaseEnd = (RELIABILITY_END_MS - timestampMs) / HOUR_MS;
    RELIABILITY_SERVICES.forEach((service, index) => {
      const wave = 1 + 0.19 * Math.sin(absoluteHour * Math.PI / 12 + index * 0.63) + 0.035 * Math.cos(absoluteHour * 1.87 + index);
      const requests = Math.round(service.requestsPerHour * wave);
      let ratio = service.errorRatio * (0.91 + 0.18 * Math.sin(absoluteHour * 0.61 + index) ** 2);
      if (scenario !== 'steady') {
        if (service.id === 'payment-api' && hoursBeforeBaseEnd <= 2) {
          ratio += hoursBeforeBaseEnd >= 0
            ? [0.0068, 0.0089, 0.0059][hoursBeforeBaseEnd]
            : 0.0048 + 0.0016 * Math.sin(absoluteHour * 0.67) ** 2;
        }
        if (service.id === 'payment-api' && hoursBeforeBaseEnd >= 218 && hoursBeforeBaseEnd < 222) ratio += 0.012;
        if (service.id === 'auth-api' && hoursBeforeBaseEnd >= 87 && hoursBeforeBaseEnd < 90) ratio += 0.006;
        if (service.id === 'uptime-api' && hoursBeforeBaseEnd >= 399 && hoursBeforeBaseEnd < 402) ratio += 0.009;
      }
      const missing = scenario === 'gaps' && (
        (hoursBeforeBaseEnd >= 26 && hoursBeforeBaseEnd < 30) ||
        (hoursBeforeBaseEnd >= 0 && hoursBeforeBaseEnd < 2 && service.id === 'payment-api')
      );
      points.push({ timestampMs, serviceId: service.id, requests: missing ? null : requests, failures: missing ? null : Math.round(requests * ratio) });
    });
  }
  return { startMs, endMs, days, scenario, revision, points };
}

export function summarizeReliability(dataset: ReliabilityDataset, scope: ReliabilityScope = 'all', startMs = dataset.startMs, endMs = dataset.endMs): ReliabilitySummary {
  const selected = dataset.points.filter(point => serviceMatch(point, scope) && point.timestampMs > startMs && point.timestampMs <= endMs);
  const observed = selected.filter(point => point.requests !== null && point.failures !== null);
  const requests = observed.reduce((sum, point) => sum + (point.requests ?? 0), 0);
  const failures = observed.reduce((sum, point) => sum + (point.failures ?? 0), 0);
  const errorRatio = requests > 0 ? failures / requests : null;
  const allowedFailures = requests * ALLOWED_ERROR_RATIO;
  const expectedIntervals = Math.round((endMs - startMs) / HOUR_MS) * (scope === 'all' ? RELIABILITY_SERVICES.length : 1);
  return { requests, failures, errorRatio, availability: errorRatio === null ? null : 1 - errorRatio, allowedFailures,
    budgetRemaining: allowedFailures > 0 ? 1 - failures / allowedFailures : null,
    observedIntervals: observed.length, expectedIntervals, coverage: expectedIntervals > 0 ? observed.length / expectedIntervals : 0 };
}

export function reliabilityBurnSeries(dataset: ReliabilityDataset, scope: ReliabilityScope = 'all'): BurnPoint[] {
  const count = scope === 'all' ? RELIABILITY_SERVICES.length : 1;
  const grouped = new Map<number, ReliabilityPoint[]>();
  for (const point of dataset.points) if (serviceMatch(point, scope)) {
    const bucket = grouped.get(point.timestampMs) ?? [];
    bucket.push(point); grouped.set(point.timestampMs, bucket);
  }
  const result: BurnPoint[] = [];
  for (let timestampMs = dataset.startMs + HOUR_MS; timestampMs <= dataset.endMs; timestampMs += HOUR_MS) {
    const current = grouped.get(timestampMs) ?? [];
    const complete = current.length === count && current.every(point => point.requests !== null && point.failures !== null);
    const requests = complete ? current.reduce((sum, point) => sum + (point.requests ?? 0), 0) : null;
    const failures = complete ? current.reduce((sum, point) => sum + (point.failures ?? 0), 0) : null;
    const history = Array.from({ length: 6 }, (_, index) => grouped.get(timestampMs - index * HOUR_MS) ?? []).flat();
    const historyComplete = history.length === 6 * count && history.every(point => point.requests !== null && point.failures !== null);
    const historyRequests = history.reduce((sum, point) => sum + (point.requests ?? 0), 0);
    const historyFailures = history.reduce((sum, point) => sum + (point.failures ?? 0), 0);
    result.push({ timestampMs, requests, failures, complete,
      oneHour: requests !== null && requests > 0 && failures !== null ? (failures / requests) / ALLOWED_ERROR_RATIO : null,
      sixHour: historyComplete && historyRequests > 0 ? (historyFailures / historyRequests) / ALLOWED_ERROR_RATIO : null });
  }
  return result;
}

export function reliabilityTimeline(dataset: ReliabilityDataset, serviceId: ReliabilityServiceId): StateInterval[] {
  const bucketHours = dataset.days === 30 ? 12 : dataset.days === 7 ? 3 : 1;
  const burns = reliabilityBurnSeries(dataset, serviceId);
  const intervals: StateInterval[] = [];
  for (let startMs = dataset.startMs; startMs < dataset.endMs; startMs += bucketHours * HOUR_MS) {
    const endMs = Math.min(dataset.endMs, startMs + bucketHours * HOUR_MS);
    const summary = summarizeReliability(dataset, serviceId, startMs, endMs);
    const values = burns.filter(point => point.timestampMs > startMs && point.timestampMs <= endMs).map(point => point.oneHour).filter((value): value is number => value !== null);
    const worstHourBurn = values.length ? Math.max(...values) : null;
    intervals.push({ ...summary, startMs, endMs, worstHourBurn,
      state: summary.coverage < 1 || worstHourBurn === null ? 'missing' : worstHourBurn > 2 ? 'breaching' : worstHourBurn > 1 ? 'elevated' : 'healthy' });
  }
  return intervals;
}

export function reliabilityIncidents(dataset: ReliabilityDataset, scope: ReliabilityScope = 'all'): ReliabilityIncident[] {
  if (dataset.scenario === 'steady') return [];
  const definitions = [
    { serviceId: 'payment-api' as const, ago: 3, duration: 3, title: 'Dependency timeouts', active: true },
    { serviceId: 'auth-api' as const, ago: 90, duration: 3, title: 'Token validation retries', active: false },
    { serviceId: 'payment-api' as const, ago: 222, duration: 4, title: 'Payment gateway saturation', active: false },
    { serviceId: 'uptime-api' as const, ago: 402, duration: 3, title: 'Probe response degradation', active: false },
  ];
  return definitions.map(event => ({ id: `${event.serviceId}-${event.ago}`, serviceId: event.serviceId,
    startMs: RELIABILITY_END_MS - event.ago * HOUR_MS,
    endMs: event.active ? dataset.endMs : RELIABILITY_END_MS - (event.ago - event.duration) * HOUR_MS,
    title: event.title, status: event.active ? 'Active' as const : 'Resolved' as const }))
    .filter(event => event.endMs > dataset.startMs && event.startMs < dataset.endMs && (scope === 'all' || event.serviceId === scope));
}

export interface IncidentCalendarDay {
  key: string;
  number: number;
  label: string;
  inMonth: boolean;
  inWindow: boolean;
  episodeIds: string[];
  activeCount: number;
  resolvedCount: number;
  state: 'outside' | 'none' | 'resolved' | 'active';
}

export interface IncidentCalendar {
  month: string;
  monthLabel: string;
  availableMonths: string[];
  days: IncidentCalendarDay[];
}

/**
 * Partition real episode intervals into local calendar dates. Both the selected
 * window and episodes use [start, end), so a midnight end never leaks into the
 * following day. Civil-date iteration deliberately avoids adding 24 hours to
 * zoned instants: local days can be 23 or 25 hours across daylight saving.
 * A calendar count is episode presence, never severity or an alert policy.
 */
export function incidentCalendar({ startMs, endMs, incidents, timeZone, month }: {
  startMs: number;
  endMs: number;
  incidents: readonly ReliabilityIncident[];
  timeZone: string;
  month?: string | null;
}): IncidentCalendar {
  if (endMs <= startMs) throw new RangeError('An incident calendar needs a nonempty time window.');
  const zonedDate = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = (timestampMs: number) => {
    const parts = zonedDate.formatToParts(timestampMs);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
  };
  const firstDay = dateKey(startMs);
  const lastDay = dateKey(endMs - 1);
  const firstMonth = firstDay.slice(0, 7);
  const lastMonth = lastDay.slice(0, 7);
  const availableMonths: string[] = [];
  const [firstYear, firstMonthNumber] = firstMonth.split('-').map(Number);
  const monthCursor = new Date(Date.UTC(firstYear, firstMonthNumber - 1, 1));
  while (monthCursor.toISOString().slice(0, 7) <= lastMonth) {
    availableMonths.push(monthCursor.toISOString().slice(0, 7));
    monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1);
  }
  const selectedMonth = month && availableMonths.includes(month) ? month : lastMonth;
  const [year, monthNumber] = selectedMonth.split('-').map(Number);
  const firstOfMonth = new Date(Date.UTC(year, monthNumber - 1, 1));
  const mondayOffset = (firstOfMonth.getUTCDay() + 6) % 7;
  const firstCell = firstOfMonth.getTime() - mondayOffset * 24 * HOUR_MS;
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const longDate = new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const episodeDates = incidents
    .filter(event => event.startMs < endMs && event.endMs > startMs && event.endMs > event.startMs)
    .map(event => ({ event, first: dateKey(Math.max(startMs, event.startMs)), last: dateKey(Math.min(endMs, event.endMs) - 1) }));
  const days = Array.from({ length: cellCount }, (_, index): IncidentCalendarDay => {
    // These UTC timestamps are civil-date arithmetic only, never query instants.
    const civilDate = new Date(firstCell + index * 24 * HOUR_MS);
    const key = civilDate.toISOString().slice(0, 10);
    const inWindow = key >= firstDay && key <= lastDay;
    const matching = inWindow ? episodeDates.filter(event => event.first <= key && event.last >= key).map(item => item.event) : [];
    const activeCount = matching.filter(event => event.status === 'Active').length;
    return { key, number: civilDate.getUTCDate(), label: longDate.format(civilDate), inMonth: key.startsWith(selectedMonth), inWindow,
      episodeIds: matching.map(event => event.id), activeCount, resolvedCount: matching.length - activeCount,
      state: !inWindow ? 'outside' : activeCount ? 'active' : matching.length ? 'resolved' : 'none' };
  });
  return { month: selectedMonth,
    monthLabel: new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(firstOfMonth),
    availableMonths, days };
}
