"use client"

import { Check } from "lucide-react"

import { Button } from "@/components/ui/button"

const CAPSICUM_STEM = String.raw`           __
          / /_
      ___/    \_`

const CAPSICUM_BODY = String.raw`   .-'   \__.-' '-.
  /   .-.     .-.  \
 /   /   \   /   \  \
 |   |    \_/    |  |
 |   |           |  |
 |   |           |  |
  \   \         /  /
   \   '-.___.-'  /
    '.    |    .'
      '-._/ \_.-'`

export function CapsicumMark({ large = false }: { large?: boolean }) {
  return (
    <pre
      aria-hidden="true"
      className={`mx-auto w-fit select-none font-mono leading-[1.15] text-[#b44032] ${
        large ? "text-[12px] sm:text-[14px]" : "text-[7px]"
      }`}
    >
      <span className="text-[#4a7c52]">{CAPSICUM_STEM}</span>
      {"\n"}
      {CAPSICUM_BODY}
    </pre>
  )
}

/**
 * Approval is complete; the client still needs to exchange its code. The
 * validated callback stays in the parent component's memory and is never
 * rendered, persisted, or sent to a second window.
 */
export function AuthorizationApproved({
  account,
  instance,
  writeGranted,
  onContinue,
}: {
  account: string
  instance: string
  writeGranted: boolean
  onContinue: () => void
}) {
  return (
    <section
      aria-labelledby="approval-heading"
      className="w-full max-w-md rounded-[2px] border border-border/60 bg-card px-6 py-9 text-center sm:px-9 sm:py-10"
    >
      <div role="status" className="mb-7 inline-flex items-center gap-2 text-sm font-medium text-status-healthy-text">
        <Check aria-hidden="true" className="size-4" />
        Access approved
      </div>
      <CapsicumMark large />
      <h1 id="approval-heading" className="mt-5 font-cond text-5xl font-semibold leading-none tracking-tight">
        add some spice
      </h1>
      <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
        Paprika is ready. Continue to your application to finish connecting.
      </p>
      <dl className="my-7 space-y-3 border-y border-border/60 py-4 text-left text-sm">
        {instance && (
          <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4">
            <dt className="text-muted-foreground">Instance</dt>
            <dd className="break-all font-medium sm:text-right">{instance}</dd>
          </div>
        )}
        <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-4">
          <dt className="text-muted-foreground">Account</dt>
          <dd className="break-all font-medium sm:text-right">{account}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Access</dt>
          <dd className="font-medium">{writeGranted ? "Read and write" : "Read only"}</dd>
        </div>
      </dl>
      <Button className="w-full" type="button" onClick={onContinue}>
        Continue to application
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        Your application will confirm when the connection is complete.
      </p>
    </section>
  )
}
