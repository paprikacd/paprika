"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"

interface ConnectionState {
  connected: boolean
  online: boolean
  lastRequestSucceeded: boolean | null
  reportRequestOutcome: (succeeded: boolean) => void
  /** @deprecated Use reportRequestOutcome. */
  setConnected: (succeeded: boolean) => void
  /** @deprecated Push events are disabled until an authorized watch API exists. */
  events: readonly MessageEvent["data"][]
}

const EMPTY_EVENTS: readonly MessageEvent["data"][] = []

const ConnectionContext = createContext<ConnectionState>({
  connected: false,
  online: true,
  lastRequestSucceeded: null,
  reportRequestOutcome: () => {},
  setConnected: () => {},
  events: EMPTY_EVENTS,
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  )
  const [lastRequestSucceeded, setLastRequestSucceeded] = useState<boolean | null>(null)

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  const reportRequestOutcome = useCallback((succeeded: boolean) => {
    setLastRequestSucceeded(succeeded)
  }, [])

  const value = useMemo<ConnectionState>(() => ({
    connected: online && lastRequestSucceeded === true,
    online,
    lastRequestSucceeded,
    reportRequestOutcome,
    setConnected: reportRequestOutcome,
    events: EMPTY_EVENTS,
  }), [lastRequestSucceeded, online, reportRequestOutcome])

  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  return useContext(ConnectionContext)
}
