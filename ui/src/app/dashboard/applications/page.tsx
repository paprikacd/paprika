import Link from "next/link"

export default function ApplicationsPlaceholderPage() {
  return (
    <section aria-labelledby="applications-title" className="mx-auto max-w-7xl px-6 py-10">
      <p className="font-mono text-[0.625rem] font-medium uppercase tracking-[0.18em] text-primary">
        Fleet inventory
      </p>
      <h1 id="applications-title" className="mt-3 text-3xl font-semibold tracking-tight">
        Applications
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
        The enterprise inventory is being prepared. Existing application details remain available from the
        operational overview.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-flex min-h-11 items-center border border-border bg-secondary px-4 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-muted"
      >
        Open current overview
      </Link>
    </section>
  )
}
