"use client"

import { ShieldAlert, ShieldCheck } from "lucide-react"

import { useAdminSession } from "@/lib/admin-session-context"

export function AdminSessionBanner() {
  const session = useAdminSession()

  if (session.status === "ordinary") return null

  if (session.status === "admin") {
    return (
      <aside
        role="status"
        aria-label="Kubernetes port-forward admin session"
        aria-live="polite"
        aria-atomic="true"
        data-admin-session-banner
        className="border-b border-amber-300 bg-amber-400 px-4 py-2 text-slate-950 sm:px-6"
      >
        <div
          data-admin-session-content
          className="flex min-w-0 flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-5"
        >
          <div
            data-admin-session-identity
            className="flex min-w-0 flex-1 items-start gap-2 sm:items-center"
          >
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0 sm:mt-0"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="font-semibold">
                Kubernetes port-forward admin session · unrestricted Paprika
                access
              </p>
              <p className="min-w-0 break-all font-mono text-[0.6875rem]">
                Reviewed Kubernetes subject: {session.subject}
              </p>
            </div>
          </div>
          <p className="min-w-0 shrink-0 font-medium">
            To end this unrestricted session, stop the Paprika admin CLI.
          </p>
        </div>
      </aside>
    )
  }

  return (
    <aside
      role="alert"
      aria-label="Session security status unknown"
      aria-live="assertive"
      aria-atomic="true"
      data-admin-session-banner
      className="border-b border-red-300 bg-red-700 px-4 py-2 text-white sm:px-6"
    >
      <div
        data-admin-session-content
        className="flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-5"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
          <p className="font-semibold">Session security status unknown</p>
        </div>
        <button
          type="button"
          onClick={session.retry}
          className="min-h-11 self-start border border-white/70 px-4 text-xs font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-red-700 sm:min-h-9 sm:self-auto"
        >
          Retry
        </button>
      </div>
    </aside>
  )
}
