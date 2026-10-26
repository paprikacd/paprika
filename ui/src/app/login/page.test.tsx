import { StrictMode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({
  user: null as null | { email: string }, isLoading: false,
  login: vi.fn(), persistAuth: vi.fn(),
}))
vi.mock("@/lib/auth-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth-context")>(),
  useAuth: () => auth,
  persistAuth: auth.persistAuth,
}))
import LoginPage from "./page"

const originalLocation = window.location
beforeEach(() => {
  auth.user = null
  auth.isLoading = false
  auth.persistAuth.mockReset()
  localStorage.clear()
  Object.defineProperty(window, "location", {
    value: { href: "", pathname: "/login/" }, configurable: true, writable: true,
  })
})
afterEach(() => {
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true })
  vi.unstubAllGlobals()
  localStorage.clear()
})

function submitLogin() {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "fixture" } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture-password" } })
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
}

describe("login resumes the pending MCP connection", () => {
  it.each(["/observe/consent?rid=opaque", "/mcp/consent/?rid=fleet"]) (
    "returns successful basic login to %s and consumes it once", async (dest) => {
      localStorage.setItem("paprika_return_to", dest)
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "fixture-token" }) }))
      render(<LoginPage />)
      submitLogin()
      await waitFor(() => expect(window.location.href).toBe(dest))
      expect(auth.persistAuth).toHaveBeenCalledWith("fixture-token")
      expect(localStorage.getItem("paprika_return_to")).toBeNull()
    }
  )
  it("keeps the destination on failed login", async () => {
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "Invalid credentials" }))
    render(<LoginPage />)
    submitLogin()
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials")
    expect(window.location.href).toBe("")
    expect(localStorage.getItem("paprika_return_to")).toBe("/observe/consent?rid=opaque")
  })
  it("resumes an already authenticated user's pending consent", async () => {
    auth.user = { email: "fixture@example.test" }
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    render(<LoginPage />)
    await waitFor(() => expect(window.location.href).toBe("/observe/consent?rid=opaque"))
  })
  it("does not consume the destination twice during StrictMode effect replay", async () => {
    auth.user = { email: "fixture@example.test" }
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    render(<StrictMode><LoginPage /></StrictMode>)
    await waitFor(() => expect(window.location.href).toBe("/observe/consent?rid=opaque"))
  })
  it("uses the dashboard for ordinary sign-in without a pending request", async () => {
    auth.user = { email: "fixture@example.test" }
    render(<LoginPage />)
    await waitFor(() => expect(window.location.href).toBe("/dashboard/"))
  })
})
