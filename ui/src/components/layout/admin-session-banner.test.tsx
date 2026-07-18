import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const adminSession = vi.hoisted(() => ({
  retry: vi.fn(),
  status: "ordinary" as "admin" | "ordinary" | "unknown",
  subject: undefined as string | undefined,
}))

vi.mock("@/lib/admin-session-context", () => ({
  useAdminSession: () => adminSession,
}))

import { AdminSessionBanner } from "@/components/layout/admin-session-banner"

describe("AdminSessionBanner", () => {
  beforeEach(() => {
    adminSession.status = "ordinary"
    adminSession.subject = undefined
    adminSession.retry.mockReset()
  })

  it("renders nothing for an explicitly ordinary session", () => {
    const { container } = render(<AdminSessionBanner />)

    expect(container).toBeEmptyDOMElement()
  })

  it("persistently marks reviewed unrestricted access with exact accessible copy", () => {
    adminSession.status = "admin"
    adminSession.subject = "alice@example.com"

    render(<AdminSessionBanner />)

    const banner = screen.getByRole("status", {
      name: "Kubernetes port-forward admin session",
    })
    expect(banner).toHaveAttribute("aria-live", "polite")
    expect(banner).toHaveAttribute("aria-atomic", "true")
    expect(banner).toHaveTextContent(
      "Kubernetes port-forward admin session · unrestricted Paprika access",
    )
    expect(banner).toHaveTextContent(
      "Reviewed Kubernetes subject: alice@example.com",
    )
    expect(banner).toHaveTextContent(
      "To end this unrestricted session, stop the Paprika admin CLI.",
    )
    expect(banner).toHaveClass(
      "border-amber-300",
      "bg-amber-400",
      "text-slate-950",
    )
    expect(banner).not.toHaveClass("fixed", "absolute")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("wraps a maximal reviewed subject safely at every breakpoint", () => {
    adminSession.status = "admin"
    adminSession.subject =
      `system:serviceaccount:${"namespace".repeat(8)}:${"service-account".repeat(20)}`

    const { container } = render(<AdminSessionBanner />)

    const banner = screen.getByRole("status")
    const content = container.querySelector("[data-admin-session-content]")
    const identity = container.querySelector("[data-admin-session-identity]")
    const subject = screen.getByText(/Reviewed Kubernetes subject:/)
    const reminder = screen.getByText(/stop the Paprika admin CLI/i)

    expect(banner).toHaveClass("px-4", "sm:px-6")
    expect(content).toHaveClass("min-w-0", "flex-col", "sm:flex-row")
    expect(identity).toHaveClass("min-w-0", "flex-1")
    expect(subject).toHaveClass("min-w-0", "break-all")
    expect(subject).not.toHaveClass(
      "sm:break-normal",
      "whitespace-nowrap",
      "truncate",
      "overflow-hidden",
    )
    expect(subject).toHaveTextContent(adminSession.subject)
    expect(reminder).toHaveClass("min-w-0")

    for (const element of [banner, content, identity, subject, reminder]) {
      expect(element?.className).not.toMatch(
        /(?:^|\s)(?:fixed|absolute|w-\[[^\]]+\])(?:\s|$)/,
      )
    }
  })

  it("fails visibly safe on uncertainty with an immediate keyboard action", async () => {
    adminSession.status = "unknown"
    const user = userEvent.setup()

    render(<AdminSessionBanner />)

    const banner = screen.getByRole("alert", {
      name: "Session security status unknown",
    })
    expect(banner).toHaveAttribute("aria-live", "assertive")
    expect(banner).toHaveAttribute("aria-atomic", "true")
    expect(banner).toHaveTextContent("Session security status unknown")
    expect(banner).toHaveClass(
      "border-red-300",
      "bg-red-700",
      "text-white",
    )
    const retry = screen.getByRole("button", { name: "Retry" })
    expect(retry).toHaveAttribute("type", "button")
    expect(retry).toHaveClass("min-h-11", "focus-visible:ring-2")
    retry.focus()
    expect(retry).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(adminSession.retry).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole("button", { name: /close|dismiss/i }),
    ).not.toBeInTheDocument()
  })
})
