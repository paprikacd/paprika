import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardCanvas } from "./canvas";
import type { Dashboard, QueryResult } from "./schema";

vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));

const dashboard: Dashboard = {
  schemaVersion: 1, id: "lazy", title: "Lazy", timeRange: "1h", refreshInterval: 0,
  widgets: [{ id: "requests", title: "Requests", type: "timeseries", providerId: "prom", query: "requests", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
};
const providers = [{ id: "prom", name: "Prometheus", type: "prometheus" as const, capabilities: ["metrics" as const] }];

afterEach(() => { vi.unstubAllGlobals(); });

describe("deferred widget queries", () => {
  it("retries the same failed query and renders the recovered result", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("Provider unavailable")).mockResolvedValueOnce({ series: [{ name: "requests", labels: {}, points: [{ timestamp: 2000000, value: 42 }] }] });
    render(<DashboardCanvas dashboard={dashboard} active providers={providers} fetcher={fetcher} end={3600} editing={false} onSelect={vi.fn()} onLayout={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry query for Requests" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toEqual(fetcher.mock.calls[0][0]);
    expect(await screen.findByRole("img", { name: "Requests" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not offer a retry for an unconfigured provider", async () => {
    const fetcher = vi.fn();
    render(<DashboardCanvas dashboard={dashboard} active providers={[]} fetcher={fetcher} end={3600} editing={false} onSelect={vi.fn()} onLayout={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("is not configured");
    expect(screen.queryByRole("button", { name: /Retry query/ })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["empty", "failure"])("distinguishes deferred, loading and actual %s", async outcome => {
    let observerCallback: IntersectionObserverCallback = () => {};
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    });
    let resolve!: (value: QueryResult) => void;
    let reject!: (error: Error) => void;
    const fetcher = vi.fn(() => new Promise<QueryResult>((yes, no) => { resolve = yes; reject = no; }));
    render(<DashboardCanvas dashboard={dashboard} active providers={providers} fetcher={fetcher} end={3600} editing={false} onSelect={vi.fn()} onLayout={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Widget waiting to load" })).toBeInTheDocument();
    expect(screen.queryByText("No data in this time range")).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    act(() => observerCallback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(screen.getByRole("status", { name: "Loading widget" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => outcome === "empty" ? resolve({ series: [] }) : reject(new Error("Provider unavailable")));
    if (outcome === "empty") expect(screen.getByText("No data in this time range")).toBeInTheDocument();
    else expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.queryByRole("status", { name: "Widget waiting to load" })).not.toBeInTheDocument();
  });
});
