"use client"

import { useEffect, useRef, useState } from "react"

export interface PipelineSSEEvent {
  type: string
  resourceType: string
  name: string
  namespace: string
  phase: string
  previousPhase?: string
  reason?: string
  message?: string
  timestamp: string
}

export function usePipelineSSE(
  namespace: string,
  name: string,
  onEvent: (event: PipelineSSEEvent) => void
) {
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)

  useEffect(() => {
    onEventRef.current = onEvent
  })

  useEffect(() => {
    if (!namespace || !name) {
      return
    }
    const topic = `pipeline/${namespace}/${name}`
    const es = new EventSource(`/events?topic=${encodeURIComponent(topic)}`)

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data)
        if (typeof parsed.type === "string") {
          onEventRef.current(parsed as PipelineSSEEvent)
        }
      } catch {
        // ignore malformed events
      }
    }

    return () => es.close()
  }, [namespace, name])

  return connected
}
