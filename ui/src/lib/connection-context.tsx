"use client"

import { createContext, useContext, useEffect, useState } from "react"

const ConnectionContext = createContext<{
  connected: boolean
  events: MessageEvent["data"][]
  setConnected: (v: boolean) => void
}>({
  connected: false,
  events: [],
  setConnected: () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false)
  const [events, setEvents] = useState<MessageEvent["data"][]>([])

  useEffect(() => {
    const source = new EventSource("/events")
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (e) => {
      setEvents((prev) => [...prev.slice(-99), e.data])
    }
    return () => source.close()
  }, [])

  return (
    <ConnectionContext.Provider value={{ connected, events, setConnected }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  return useContext(ConnectionContext)
}