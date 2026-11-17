// Reusable react-grid-layout mock for lab DOM tests. Opt in per test file:
//
//   // @vitest-environment happy-dom
//   vi.mock('react-grid-layout', () => import('./support/rgl-mock'));
//
// It mirrors the mock in ui/src/features/insights/canvas-layout-edit.test.tsx (lines 17-27). The grid records the props
// of every render (`rglMock.props` is the latest, `rglMock.renders` holds all of them) and renders its children inside
// a plain element, so tiles mount and their props can be asserted without a layout engine. `useContainerWidth` reports
// a wide canvas, which is the mode where production's canvas is editable. `verticalCompactor` is the stock compactor
// from react-grid-layout/core, so compaction runs real code under the mock.
import { createElement } from 'react';
import type { ReactGridLayoutProps } from 'react-grid-layout';
import { verticalCompactor as stockVerticalCompactor } from 'react-grid-layout/core';

/** Canvas width that puts production's canvas in wide mode, where editing is available. */
export const WIDE_CANVAS_WIDTH = 1440;

export interface RglMockState {
  /** Props of the most recent ReactGridLayout render, or undefined before the first one. */
  props: ReactGridLayoutProps | undefined;
  /** Props of every ReactGridLayout render, oldest first. */
  renders: ReactGridLayoutProps[];
  /** The width useContainerWidth reports. */
  width: number;
}

export const rglMock: RglMockState = { props: undefined, renders: [], width: WIDE_CANVAS_WIDTH };

/** Clears the captured renders and sets the reported width. Call it from beforeEach. */
export function resetRglMock(width: number = WIDE_CANVAS_WIDTH): void {
  rglMock.props = undefined;
  rglMock.renders = [];
  rglMock.width = width;
}

/** The grid component. Records the props it was rendered with and renders the tiles inside a plain element. */
export default function ReactGridLayout(props: ReactGridLayoutProps) {
  rglMock.props = props;
  rglMock.renders.push(props);
  return createElement('div', { 'data-testid': 'saved-grid' }, props.children);
}

/** Stands in for react-grid-layout's hook: a fixed width, mounted at once, and a ref object for the canvas to attach. */
export function useContainerWidth(_options?: unknown) {
  return { width: rglMock.width, containerRef: { current: null }, mounted: true };
}

/** The stock vertical compactor, so the canvas's compaction runs real code under the mock. */
export const verticalCompactor = stockVerticalCompactor;
