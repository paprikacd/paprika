import type { Widget } from '../../vendor/paprika/ui/src/features/insights/schema';

/** Presentation changes follow a renderer; query identity follows the current lens. */
export function mergeDomainWidget(source: Widget, override: Widget | null, selection?: Widget['config']): Widget {
  const sameRenderer = !override || (source.type === override.type && source.pluginId === override.pluginId);
  const merged = { ...source, ...override, id: source.id, providerId: source.providerId, query: source.query };
  if (merged.type === 'plugin') return { ...merged, config: sameRenderer
    ? { ...source.config, ...override?.config, ...selection }
    : override?.config ?? {} };
  const { pluginId: _plugin, dataKind: _kind, config: _config, ...builtin } = merged;
  return builtin;
}
