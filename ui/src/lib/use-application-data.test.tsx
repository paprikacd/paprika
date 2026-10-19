import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const client = vi.hoisted(() => ({getApplication: vi.fn(), queryApplications: vi.fn(), listReleases: vi.fn(), getResourceTreeDetailed: vi.fn(), getDataSources: vi.fn()}))
vi.mock("@connectrpc/connect", () => ({Code: {NotFound: 5}, createPromiseClient: () => client}))
vi.mock("@/lib/transport", () => ({createTransport: () => ({})}))
import { useApplicationData } from "./use-application-data"
import { ApplicationSummary, QueryApplicationsResponse } from "@/gen/paprika/v1/api_pb"

function setup() {
  const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const wrapper = ({children}: {children: React.ReactNode}) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return {wrapper}
}
beforeEach(() => {
  vi.clearAllMocks()
  client.getApplication.mockImplementation(({namespace, name}) => Promise.resolve({application: {namespace, name}}))
  client.listReleases.mockResolvedValue({releases: []})
  client.getResourceTreeDetailed.mockResolvedValue({nodes: []})
  client.getDataSources.mockResolvedValue({sources: []})
  client.queryApplications.mockResolvedValue(new QueryApplicationsResponse())
})
describe("application query cache", () => {
  it("renders application data independently of a slow resource tree and reuses warm visits", async () => {
    client.getResourceTreeDetailed.mockReturnValue(new Promise(() => {}))
    const {wrapper} = setup()
    const first = renderHook(() => useApplicationData("a", "api", true), {wrapper})
    await waitFor(() => expect(first.result.current.application.isSuccess).toBe(true))
    expect(first.result.current.tree.isPending).toBe(true)
    first.unmount()
    const next = renderHook(() => useApplicationData("a", "api", false), {wrapper})
    expect(next.result.current.application.data?.application?.name).toBe("api")
    expect(client.getApplication).toHaveBeenCalledTimes(1)
  })
  it("does not show another namespace's cache and refreshes dynamic data without reloading capabilities", async () => {
    const {wrapper} = setup()
    const hook = renderHook(({namespace}) => useApplicationData(namespace, "api", true), {wrapper, initialProps: {namespace: "a"}})
    await waitFor(() => expect(hook.result.current.application.isSuccess).toBe(true))
    hook.rerender({namespace: "b"})
    expect(hook.result.current.application.data).toBeUndefined()
    await waitFor(() => expect(hook.result.current.application.data?.application?.namespace).toBe("b"))
    await act(async () => {await hook.result.current.refresh()})
    expect(client.getApplication).toHaveBeenCalledTimes(3)
    expect(client.getDataSources).toHaveBeenCalledTimes(2)
  })
  it("finds an exact satellite identity across pages without querying central-only detail sources", async () => {
    client.getApplication.mockRejectedValue({code: 5})
    client.queryApplications.mockResolvedValueOnce(new QueryApplicationsResponse({
      applications: [new ApplicationSummary({identity: {namespace: "b", name: "api"}})], nextCursor: "page-2",
    })).mockResolvedValueOnce(new QueryApplicationsResponse({
      applications: [new ApplicationSummary({identity: {namespace: "a", name: "api"}})],
    }))
    const {wrapper} = setup()
    const hook = renderHook(() => useApplicationData("a", "api", true), {wrapper})
    await waitFor(() => expect(hook.result.current.observation.data?.summary?.identity).toEqual({namespace: "a", name: "api"}))
    expect(client.queryApplications).toHaveBeenCalledTimes(2)
    expect(client.queryApplications.mock.calls[0][0].filter.namespaces).toEqual(["a"])
    expect(client.queryApplications.mock.calls[1][0].cursor).toBe("page-2")
    expect(client.listReleases).not.toHaveBeenCalled()
    expect(client.getResourceTreeDetailed).not.toHaveBeenCalled()
  })
  it("does not hide a failed observation refresh behind the expected missing central Application", async () => {
    client.getApplication.mockRejectedValue({code: 5})
    client.queryApplications.mockResolvedValue(new QueryApplicationsResponse({applications: [new ApplicationSummary({identity: {namespace: "a", name: "api"}})]}))
    const {wrapper} = setup()
    const hook = renderHook(() => useApplicationData("a", "api", true), {wrapper})
    await waitFor(() => expect(hook.result.current.observation.data?.summary).toBeDefined())
    client.queryApplications.mockRejectedValue(new Error("Observation source unavailable"))
    await act(async () => { await expect(hook.result.current.refresh()).rejects.toThrow("Observation source unavailable") })
    expect(hook.result.current.observation.data?.summary?.identity?.name).toBe("api")
  })
})
