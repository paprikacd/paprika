import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ProviderManager, validateProviderConfig } from "./provider-manager"
import type { InsightsClient, ProviderConfig } from "./client"
import type { Provider } from "./schema"

const publicProviders: Provider[] = [
  {
    id: "prod",
    name: "Production",
    type: "prometheus",
    capabilities: ["metrics"],
  },
]
const config: ProviderConfig = {
  id: "prod",
  name: "Production",
  type: "prometheus",
  url: "http://prometheus:9090",
  managed: true,
  etag: '"version-1"',
}
function makeClient(configs: ProviderConfig[] = [config]): InsightsClient {
  return {
    providers: vi.fn().mockResolvedValue(publicProviders),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue(configs),
    saveProvider: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    testProvider: vi
      .fn()
      .mockResolvedValue({ ok: true, durationMs: 12, message: "Connected" }),
    metadata: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    query: vi.fn(),
  }
}

describe("provider management", () => {
  it("chooses a trace provider with the custom keyboard combobox and saves the chosen type", async () => {
    const client = makeClient([])
    const { container } = render(<ProviderManager client={client} providers={[]} onChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Add data source" }))
    expect(container.querySelector("select")).toBeNull()
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "traces" } })
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Production traces" } })
    fireEvent.change(screen.getByLabelText("Endpoint URL"), { target: { value: "http://tempo:3200" } })
    const type = screen.getByRole("combobox", { name: "Provider type" })
    fireEvent.keyDown(type, { key: "Enter" })
    expect(screen.getByRole("listbox", { name: "Provider type options" })).toBeVisible()
    fireEvent.keyDown(type, { key: "End" })
    fireEvent.keyDown(type, { key: "Enter" })
    expect(type).toHaveTextContent("Tempo")
    expect(type).toHaveFocus()
    expect(type).toHaveAttribute("aria-expanded", "false")
    expect(client.saveProvider).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Save data source" }))
    await waitFor(() => expect(client.saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: "traces", name: "Production traces", type: "tempo", url: "http://tempo:3200",
    })))
  })

  it("uses the shared registry without exposing local edit controls or endpoint configuration", async () => {
    const shared: Provider = { ...publicProviders[0], id: "observe-shared", name: "production/prometheus", source: "observability", providerRef: "production/prometheus" }
    // Even if an inconsistent configuration list contains the same ID, a shared
    // source must never acquire legacy local edit/delete controls.
    const client = makeClient([{ ...config, id: shared.id }])
    render(<ProviderManager client={client} providers={[shared]} onChange={vi.fn()} />)
    await screen.findByRole("button", { name: "Add standalone data source" })
    const card = screen.getByRole("article")
    expect(within(card).getByText(/Shared with Observability MCP/)).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: "Manage in Observability" })).toHaveAttribute("href", "/dashboard/observability")
    expect(within(card).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument()
    expect(within(card).queryByText(config.url)).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole("button", { name: "Test connection" }))
    await waitFor(() => expect(client.testProvider).toHaveBeenCalledWith(shared.id))
    expect(await screen.findByRole("status")).toHaveTextContent("Connected")
    expect(client.saveProvider).not.toHaveBeenCalled()
    expect(client.removeProvider).not.toHaveBeenCalled()
  })

  it("keeps shared sources usable when local provider administration is denied", async () => {
    const shared: Provider = { ...publicProviders[0], source: "observability", providerRef: "production/prometheus" }
    const client = makeClient()
    vi.mocked(client.providerConfigs).mockRejectedValue(new Error("Administrator access required"))
    render(<ProviderManager client={client} providers={[shared]} onChange={vi.fn()} />)
    await screen.findByRole("alert")
    expect(screen.getByRole("link", { name: "Manage in Observability" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
    await waitFor(() => expect(client.testProvider).toHaveBeenCalledWith(shared.id))
    expect(screen.queryByRole("button", { name: "Add standalone data source" })).not.toBeInTheDocument()
  })

  it("shows provisioned providers without mutation controls", async () => {
    const client = makeClient([{ ...config, managed: false }])
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={vi.fn()}
      />,
    )
    await screen.findByText(/Provisioned by your operator/)
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Remove Production" }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
    expect(await screen.findByText(/Connected \(12 ms\)/)).toBeInTheDocument()
  })
  it("preserves concurrency tokens and refreshes the public provider list after editing", async () => {
    const client = makeClient(),
      onChange = vi.fn()
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={onChange}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }))
    expect(screen.getByLabelText("Provider ID")).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Primary metrics" },
    })
    fireEvent.change(
      screen.getByLabelText("Bearer token environment variable"),
      { target: { value: "PAPRIKA_PROVIDER_PROM_TOKEN" } },
    )
    fireEvent.change(screen.getByLabelText("Header environment variables"), {
      target: { value: "X-Scope-OrgID: PAPRIKA_PROVIDER_TENANT" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save data source" }))
    await waitFor(() =>
      expect(client.saveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "prod",
          etag: '"version-1"',
          name: "Primary metrics",
          bearerTokenEnv: "PAPRIKA_PROVIDER_PROM_TOKEN",
          headersEnv: { "X-Scope-OrgID": "PAPRIKA_PROVIDER_TENANT" },
        }),
      ),
    )
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(publicProviders))
  })
  it("uses the provider etag when removing and explains affected widgets", async () => {
    const client = makeClient()
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={vi.fn()}
      />,
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Production" }),
    )
    expect(screen.getByText(/Widgets and tooltip queries using this source/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Remove provider" }))
    await waitFor(() =>
      expect(client.removeProvider).toHaveBeenCalledWith("prod", '"version-1"'),
    )
  })
  it("keeps a rejected edit for correction without publishing changes", async () => {
    const client = makeClient(),
      onChange = vi.fn()
    vi.mocked(client.saveProvider).mockRejectedValue(
      new Error("Provider changed. Reload configuration."),
    )
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={onChange}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My pending edit" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save data source" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provider changed",
    )
    expect(screen.getByLabelText("Name")).toHaveValue("My pending edit")
    expect(onChange).not.toHaveBeenCalled()
  })
  it("keeps public provider access when administrative configuration is denied", async () => {
    const client = makeClient()
    vi.mocked(client.providerConfigs).mockRejectedValue(
      new Error("Administrator access required"),
    )
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={vi.fn()}
      />,
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Administrator access",
    )
    expect(screen.getByText("Production")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Add data source" }),
    ).not.toBeInTheDocument()
  })
  it("shows example providers without requesting or changing service configuration", () => {
    const client = makeClient()
    render(
      <ProviderManager
        client={client}
        providers={publicProviders}
        onChange={vi.fn()}
        example
      />,
    )
    expect(client.providerConfigs).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: "Test connection" }),
    ).not.toBeInTheDocument()
  })
})

describe("provider configuration validation", () => {
  it.each<Partial<ProviderConfig>>([
    { url: "https://user:secret@provider.test" },
    { url: "file:///etc/passwd" },
    { url: "https://provider.test?token=secret" },
    { bearerTokenEnv: "AWS_SECRET_ACCESS_KEY" },
    { headersEnv: { Authorization: "HOME" } },
    { headersEnv: { "bad\nheader": "PAPRIKA_PROVIDER_VALUE" } },
    { id: "../../provider" },
  ])("rejects invalid or unrelated credential references", (patch) =>
    expect(validateProviderConfig({ ...config, ...patch })).toBeTruthy(),
  )
  it("allows server-internal URLs and explicitly scoped environment references", () => {
    expect(
      validateProviderConfig({
        ...config,
        bearerTokenEnv: "PAPRIKA_PROVIDER_API_TOKEN",
        headersEnv: { "X-Scope-OrgID": "PAPRIKA_PROVIDER_ORG" },
      }),
    ).toBeUndefined()
  })
})
