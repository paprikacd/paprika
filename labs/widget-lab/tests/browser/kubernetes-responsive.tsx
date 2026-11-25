import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/insights-utilities.css';
import gamma from '@insights/gamma/gamma-theme.module.css';
import type { QueryResult, Widget } from '@insights/schema';
import { registerDefaultWidgetPlugins } from '@insights/plugins/threshold-gauge';
import { getWidgetDefinition } from '@insights/widget-registry';
import { KUBERNETES_PLUGIN_IDS, kubernetesFixture, type KubernetesPreset } from '@insights/plugins/kubernetes-fixtures';

/**
 * The four production Kubernetes widgets, each drawn at the content widths the e2e passes in `?widths=`, with the
 * production fixtures. The throttle matrix also gets a 300-sample result with long pod names, the shape a real range
 * query returns. Query: widths (comma-separated px), theme (light or dark), preset (ready or gaps).
 */

const params = new URLSearchParams(location.search);
const widths = (params.get('widths') ?? '207,330,453,700,1440').split(',').map(Number).filter(Number.isFinite);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const preset = (params.get('preset') === 'gaps' ? 'gaps' : 'ready') as KubernetesPreset;

function longThrottle(): QueryResult {
  const start = Date.UTC(2026, 10, 24), step = 60_000;
  const times = Array.from({ length: 300 }, (_, i) => start + i * step);
  const pods = ['payments-api-7d9f8c6b5-x2k4q', 'fraud-detection-worker-5c1d9-abcde', 'redis-0', 'ingress-nginx-controller-6b7f9-lmnop', 'batch'];
  return {
    series: pods.flatMap((pod, p) => [
      { name: 'throttled', labels: { pod, signal: 'throttled' }, points: times.map((timestamp, i) => ({ timestamp, value: i % 40 === 7 ? null : Math.round(60 * (0.3 + 0.3 * Math.sin(i / 17 + p))) })) },
      { name: 'periods', labels: { pod, signal: 'periods' }, points: times.map(timestamp => ({ timestamp, value: 300 })) },
    ]),
  };
}

registerDefaultWidgetPlugins();
const panels: { key: string; widget: Widget; result: QueryResult }[] = [];
for (const id of Object.values(KUBERNETES_PLUGIN_IDS)) {
  const { widget, result } = kubernetesFixture(id, preset);
  panels.push({ key: id, widget, result });
  if (id === KUBERNETES_PLUGIN_IDS.throttle) panels.push({ key: `${id}-long`, widget: { ...widget, id: `${widget.id}-long` }, result: longThrottle() });
}

function Harness() {
  return createElement('div', { className: gamma.scope, 'data-insights-theme': theme, 'data-density': 'standard', 'data-motion': 'reduced', style: { background: 'var(--gamma-bg)', color: 'var(--gamma-ink)', padding: 8, fontFamily: 'system-ui, sans-serif' } },
    panels.flatMap(panel => widths.map(width => {
      const Render = getWidgetDefinition(panel.widget)!.render;
      return createElement('section', { key: `${panel.key}-${width}`, 'data-harness': panel.key, 'data-width': width, style: { width, marginBottom: 16, outline: '1px dashed var(--gamma-border)' } },
        createElement(Render, { widget: panel.widget, result: panel.result }));
    })));
}

createRoot(document.getElementById('root')!).render(createElement(Harness));
