"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const THIRTY_SECONDS = 30_000
const TEN_MINUTES = 10 * 60_000

export function createEnterpriseQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: THIRTY_SECONDS,
        gcTime: TEN_MINUTES,
        retry: 2,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

let browserQueryClient: QueryClient | undefined

export function getBrowserQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    return createEnterpriseQueryClient()
  }
  browserQueryClient ??= createEnterpriseQueryClient()
  return browserQueryClient
}

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={getBrowserQueryClient()}>
      {children}
    </QueryClientProvider>
  )
}
