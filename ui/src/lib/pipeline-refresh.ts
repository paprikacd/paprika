"use client"

import { useFocusedRefresh, type RefreshOptions } from "@/lib/fleet-refresh"

export function usePipelineRefresh(
  namespace: string,
  name: string,
  refresh: () => Promise<unknown> | unknown,
  options: RefreshOptions = {}
) {
  useFocusedRefresh(refresh, {
    ...options,
    enabled: options.enabled !== false && Boolean(namespace && name),
  })
}
