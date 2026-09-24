"use client"

import { useEffect, useState } from "react"

// Freshness must keep aging even when the network stops delivering new data.
export function useHealthClock(): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
