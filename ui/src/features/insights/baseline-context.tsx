"use client";

import { createContext, useContext } from "react";
import type { QueryResult } from "./schema";
import type { BaselineBand, BaselineWindow } from "./baseline";

/**
 * What a time series knows about its baseline. The tile fetches the earlier window (never for rolling) and reports its state;
 * the chart computes the band from it. A chart outside a tile, or with no baseline configured, has no context.
 */
export interface BaselineState {
  window: BaselineWindow;
  band: BaselineBand;
  /** How far back the earlier window sits, in milliseconds. */
  offsetMs: number;
  /** The query step in milliseconds: neighbours lie within two steps. */
  stepMs: number;
  /** Length of the current range in milliseconds. It names the earlier window. */
  span: number;
  /** loading: the earlier window has not settled. unavailable: the range has no earlier period. error: the earlier window failed. */
  state: "loading" | "ready" | "unavailable" | "error";
  /** The earlier window's result, once it has settled. */
  prior?: QueryResult;
  /** The earlier result was truncated, so its band may be incomplete. */
  partial?: boolean;
  error?: string;
}

export const BaselineContext = createContext<BaselineState | undefined>(undefined);

export function useBaseline(): BaselineState | undefined {
  return useContext(BaselineContext);
}
