"use client"

import { createContext, useContext, useState } from "react"

const ConnectionContext = createContext<{
  connected: boolean
  setConnected: (v: boolean) => void
}>({
  connected: false,
  setConnected: () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false)
  return (
    <ConnectionContext.Provider value={{ connected, setConnected }}>
      {children}
    </ConnectionContext.Provider>
  )
}

export function useConnection() {
  return useContext(ConnectionContext)
}