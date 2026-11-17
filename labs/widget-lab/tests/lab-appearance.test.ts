import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { gammaScopeAttributes, LabAppearanceControl, type GammaScopeInput } from '../src/components/lab/appearance';

const base: GammaScopeInput = { resolved: 'dark', compact: true, desktop: true, reduced: false };

describe('lab appearance and motion scope', () => {
  it('follows the resolved System, Light or Dark appearance and never forces dark', () => {
    expect(gammaScopeAttributes({ ...base, resolved: 'light' })['data-insights-theme']).toBe('light');
    expect(gammaScopeAttributes({ ...base, resolved: 'dark', compact: false })['data-insights-theme']).toBe('dark');
  });

  it('uses production compact dark only for dark, desktop, non-editing studies', () => {
    expect(gammaScopeAttributes(base)['data-density']).toBe('compact');
    expect(gammaScopeAttributes({ ...base, resolved: 'light' })['data-density']).toBe('standard');
    expect(gammaScopeAttributes({ ...base, desktop: false })['data-density']).toBe('standard');
    expect(gammaScopeAttributes({ ...base, compact: false })['data-density']).toBe('standard');
  });

  it('writes the Auto / Reduced motion preference onto every scope as data-motion', () => {
    expect(gammaScopeAttributes({ ...base, reduced: true })['data-motion']).toBe('reduced');
    expect(gammaScopeAttributes({ ...base, reduced: false })['data-motion']).toBe('auto');
  });

  it('offers System, Light and Dark in the shared control, starting from System', () => {
    const markup = renderToStaticMarkup(createElement(LabAppearanceControl));
    expect(markup).toContain('System');
  });
});
