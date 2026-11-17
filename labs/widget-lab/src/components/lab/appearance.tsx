import { useEffect, useState } from 'react';
import { InsightsThemeControl, useInsightsTheme } from '@insights/insights-theme';
import { useLabMotion } from './motion';

// One appearance store for every lab shell: production's Light / Dark / System
// preference (default System). The resolved value follows prefers-color-scheme live.
export type ResolvedAppearance = 'light' | 'dark';
export type GammaDensity = 'compact' | 'standard';

export interface GammaScopeAttributes {
  'data-insights-theme': ResolvedAppearance;
  'data-density': GammaDensity;
  'data-motion': 'reduced' | 'auto';
}

const DESKTOP_QUERY = '(min-width: 1024px)';

export function useLabAppearance() {
  const { theme, resolvedTheme, setTheme } = useInsightsTheme();
  return { preference: theme, resolved: resolvedTheme, setPreference: setTheme };
}

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

export interface GammaScopeInput {
  resolved: ResolvedAppearance;
  /** The view opts into production's compact reading density (non-editing studies). */
  compact: boolean;
  /** The viewport is at least the compact boundary (1024px), where production's compact tokens apply. */
  desktop: boolean;
  /** Reduced motion from the lab's Auto / Reduced control, or the operating system. */
  reduced: boolean;
}

/** Pure rule behind useGammaScope: compact dark needs the dark theme, the view's opt-in and a desktop viewport. */
export function gammaScopeAttributes(input: GammaScopeInput): GammaScopeAttributes {
  return {
    'data-insights-theme': input.resolved,
    'data-density': input.compact && input.resolved === 'dark' && input.desktop ? 'compact' : 'standard',
    'data-motion': input.reduced ? 'reduced' : 'auto',
  };
}

/**
 * Attributes every Gamma scope element carries. Production's compact dark tokens need the
 * theme, `data-density="compact"` and a desktop viewport on the same element; `compact` opts in
 * for non-editing reading views (Edge Watch, Reliability Room, the reference studies).
 */
export function useGammaScope(options: { compact?: boolean } = {}): GammaScopeAttributes {
  const { resolved } = useLabAppearance();
  const motion = useLabMotion();
  const desktop = useDesktopViewport();
  return gammaScopeAttributes({ resolved, compact: options.compact === true, desktop, reduced: motion.reduced });
}

/** The shared Light / Dark / System control; each shell renders the same store. */
export function LabAppearanceControl({ className }: { className?: string }) {
  const { preference, setPreference } = useLabAppearance();
  return <InsightsThemeControl value={preference} onChange={setPreference} className={className} />;
}
