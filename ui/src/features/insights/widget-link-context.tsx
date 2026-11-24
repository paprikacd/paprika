"use client";

import type { ReactNode } from "react";
import { GammaSelect, type GammaSelectOption } from "./gamma/select";
import contextStyles from "./widget-context.module.css";

/** The series a tile's header links use. It sits beside Explore so the choice and the menu read as one control. */
export function SeriesLinkPicker({ title, value, options, searchable, onValueChange }: {
  title: string;
  value: string;
  options: readonly GammaSelectOption[];
  searchable: boolean;
  onValueChange(key: string): void;
}) {
  return (
    <GammaSelect
      aria-label={`Series for ${title}`}
      size="sm"
      className={contextStyles.headerPicker}
      value={value}
      placeholder="Series"
      searchable={searchable}
      options={options}
      onValueChange={onValueChange}
    />
  );
}

/**
 * One caption under the header. A selected sample wins over a selected series; with neither, the prompt is read by screen
 * readers only, so a sighted user sees no idle text.
 */
export function LinkContextCaption({ visible, series, sample, prompt }: {
  visible: boolean;
  series?: string;
  sample?: ReactNode;
  prompt: string;
}) {
  if (sample) return <div className={contextStyles.selection} role="status">{sample}</div>;
  if (!visible) return null;
  if (series) return <div className={contextStyles.selection} role="status">{`Selected: ${series}`}</div>;
  return <div className="sr-only" role="status">{prompt}</div>;
}
