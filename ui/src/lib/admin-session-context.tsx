"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

export type AdminSessionStatus = "admin" | "ordinary" | "unknown"

export interface AdminSessionContextValue {
  status: AdminSessionStatus
  subject?: string
  retry: () => void
}

type AdminSessionState = Omit<AdminSessionContextValue, "retry">

const ADMIN_ACCESS_MODE = "kubernetes-port-forward-admin"
const PROBE_TIMEOUT_MS = 5_000
const INITIAL_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const SESSION_DESCRIPTION_KEYS = [
  "absoluteExpiresAt",
  "accessMode",
  "idleExpiresAt",
  "subject",
] as const
const RFC3339_NANO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/
const NANOSECONDS_PER_MILLISECOND = BigInt(1_000_000)

const AdminSessionContext =
  createContext<AdminSessionContextValue | undefined>(undefined)

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminSessionState>({
    status: "unknown",
  })
  const retryProbe = useRef<() => void>(() => undefined)

  const retry = useCallback(() => retryProbe.current(), [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let queuedRetry = false
    let requestSequence = 0
    let retryAttempt = 0
    let requestController: AbortController | undefined
    let requestTimeoutTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const clearRetryTimer = () => {
      if (retryTimer === undefined) return
      clearTimeout(retryTimer)
      retryTimer = undefined
    }

    const scheduleRetry = () => {
      if (!active) return
      clearRetryTimer()
      const delay = Math.min(
        INITIAL_RETRY_MS * 2 ** retryAttempt,
        MAX_RETRY_MS,
      )
      retryAttempt += 1
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void probe()
      }, delay)
    }

    const probe = async () => {
      if (!active || inFlight) return
      inFlight = true
      clearRetryTimer()
      const sequence = ++requestSequence
      const controller = new AbortController()
      requestController = controller
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined

      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => {
            controller.abort()
            reject(new Error("admin session probe timed out"))
          }, PROBE_TIMEOUT_MS)
          requestTimeoutTimer = timeoutTimer
        })
        const result = await Promise.race([
          fetchAdminSession(controller.signal),
          timeout,
        ])
        if (!active || sequence !== requestSequence || queuedRetry) return

        if (result.status === "unknown") {
          setState({ status: "unknown" })
          scheduleRetry()
          return
        }

        retryAttempt = 0
        clearRetryTimer()
        setState(result)
      } catch {
        if (!active || sequence !== requestSequence || queuedRetry) return
        setState({ status: "unknown" })
        scheduleRetry()
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        if (sequence === requestSequence) {
          requestTimeoutTimer = undefined
          inFlight = false
          requestController = undefined
          if (active && queuedRetry) {
            queuedRetry = false
            retryAttempt = 0
            clearRetryTimer()
            void probe()
          }
        }
      }
    }

    retryProbe.current = () => {
      if (!active) return
      if (inFlight) {
        queuedRetry = true
        retryAttempt = 0
        clearRetryTimer()
        requestController?.abort()
        return
      }
      queuedRetry = false
      retryAttempt = 0
      clearRetryTimer()
      void probe()
    }

    void probe()

    return () => {
      active = false
      queuedRetry = false
      requestSequence += 1
      retryProbe.current = () => undefined
      clearRetryTimer()
      if (requestTimeoutTimer !== undefined) {
        clearTimeout(requestTimeoutTimer)
        requestTimeoutTimer = undefined
      }
      requestController?.abort()
      requestController = undefined
    }
  }, [])

  const value = useMemo<AdminSessionContextValue>(
    () => ({ ...state, retry }),
    [retry, state],
  )

  return (
    <AdminSessionContext.Provider value={value}>
      {children}
    </AdminSessionContext.Provider>
  )
}

export function useAdminSession(): AdminSessionContextValue {
  const context = useContext(AdminSessionContext)
  if (!context) {
    throw new Error("useAdminSession must be used within AdminSessionProvider")
  }
  return context
}

async function fetchAdminSession(
  signal: AbortSignal,
): Promise<AdminSessionState> {
  const response = await fetch("/admin/session", {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  })
  if (response.status === 404) return { status: "ordinary" }
  if (response.status !== 200) return { status: "unknown" }
  if (response.headers.get("Content-Type") !== "application/json") {
    return { status: "unknown" }
  }

  const body: unknown = await response.json()
  return parseAdminSession(body)
}

function parseAdminSession(value: unknown): AdminSessionState {
  if (!isRecord(value)) return { status: "unknown" }
  const keys = Object.keys(value).sort()
  if (
    keys.length !== SESSION_DESCRIPTION_KEYS.length ||
    keys.some((key, index) => key !== SESSION_DESCRIPTION_KEYS[index])
  ) {
    return { status: "unknown" }
  }

  const { absoluteExpiresAt, accessMode, idleExpiresAt, subject } = value
  const idleExpiry = parseRFC3339Nano(idleExpiresAt)
  const absoluteExpiry = parseRFC3339Nano(absoluteExpiresAt)
  if (
    typeof subject !== "string" ||
    subject.length === 0 ||
    subject.trim() !== subject ||
    accessMode !== ADMIN_ACCESS_MODE ||
    idleExpiry === null ||
    absoluteExpiry === null
  ) {
    return { status: "unknown" }
  }

  const now = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND
  if (
    idleExpiry <= now ||
    absoluteExpiry <= now ||
    idleExpiry > absoluteExpiry
  ) {
    return { status: "unknown" }
  }
  return { status: "admin", subject }
}

function parseRFC3339Nano(value: unknown): bigint | null {
  if (typeof value !== "string") return null
  const match = RFC3339_NANO_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const fraction = match[7] ?? ""
  const offsetHour = match[10] === undefined ? 0 : Number(match[10])
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11])

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null
  }

  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(hour, minute, second, 0)
  const localMilliseconds = local.getTime()
  if (!Number.isFinite(localMilliseconds)) return null

  const offsetDirection = match[9] === "-" ? -1 : 1
  const offsetMilliseconds =
    offsetDirection *
    (offsetHour * 60 + offsetMinute) *
    60_000
  const epochMilliseconds = localMilliseconds - offsetMilliseconds
  const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0")
  return (
    BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND +
    fractionNanoseconds
  )
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}
