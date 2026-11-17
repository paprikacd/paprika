import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { changeQueryEditor, readQueryEditor } from "./query-code-editor.test-utils";
import { describe, expect, it, vi } from "vitest";
import type { InsightsClient } from "./client";
import { Explorer } from "./explorer";
import type {
  Provider,
  QueryResult,
  SavedQuery,
  SavedQueryEntry,
} from "./schema";

vi.mock("./charts", () => ({
  WidgetVisualization: ({ widget }: { widget: { query: string; type?: string; pluginId?: string; dataKind?: string; config?: unknown } }) => (
    <div data-testid="result" data-widget={widget.pluginId ?? widget.type} data-kind={widget.dataKind} data-config={JSON.stringify(widget.config)}>{widget.query}</div>
  ),
}));
const providers: Provider[] = [
  {
    id: "prom",
    name: "Production metrics",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "tempo",
    name: "Production traces",
    type: "tempo",
    capabilities: ["traces"],
  },
];
const saved: SavedQueryEntry = {
  schemaVersion: 1,
  id: "availability",
  name: "Availability",
  providerId: "prom",
  kind: "metrics",
  query: "up{service={{service}}} * {{factor}}",
  parameters: [
    { name: "service", type: "string", defaultValue: "api" },
    { name: "factor", type: "number", defaultValue: 1 },
  ],
  etag: '"v1"',
};
const result: QueryResult = { series: [] };
function client(): InsightsClient {
  return {
    providers: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    query: vi.fn().mockResolvedValue(result),
    providerConfigs: vi.fn(),
    saveProvider: vi.fn(),
    removeProvider: vi.fn(),
    testProvider: vi.fn(),
    metadata: vi.fn().mockResolvedValue({ values: [] }),
    listSavedQueries: vi.fn(),
    getSavedQuery: vi.fn().mockRejectedValue(new Error("Not found")),
    saveSavedQuery: vi.fn().mockResolvedValue('"v2"'),
    removeSavedQuery: vi.fn().mockResolvedValue(undefined),
  };
}
function Harness({
  api,
  initial = [],
  active = true,
  onUse = vi.fn(),
  onClose = vi.fn(),
}: {
  api: InsightsClient;
  initial?: SavedQueryEntry[];
  active?: boolean;
  onUse?: (query: SavedQuery) => void;
  onClose?: () => void;
}) {
  const [queries, setQueries] = useState(initial);
  return (
    <Explorer
      client={api}
      providers={providers}
      queries={queries}
      onQueriesChange={setQueries}
      onUse={onUse}
      onClose={onClose}
      active={active}
    />
  );
}
function edit(label: string, value: string) {
  const element = screen.getByLabelText(label);
  if (element.getAttribute("contenteditable") === "true") changeQueryEditor(element, value);
  else fireEvent.change(element, { target: { value } });
}
function queryValue(label: string) {
  return readQueryEditor(screen.getByLabelText(label));
}
async function openSaved() {
  fireEvent.click(screen.getByRole("combobox", { name: "Open saved query" }));
  fireEvent.click(await screen.findByRole("option", { name: /Availability/ }));
  await screen.findByDisplayValue("Availability");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    resolve,
    reject,
  };
}

describe("Explore query workspace", () => {
  it("requires explicit result columns for record chart previews without requerying the provider", async () => {
    const api = client()
    vi.mocked(api.query).mockResolvedValue({ records: { columns: [{ key: "service", type: "string" }, { key: "count", type: "number" }], rows: [["api", 10]], truncated: true } })
    render(<Explorer client={api} providers={[{ id: "app", name: "Uptime", type: "uptime", capabilities: ["records"] }]} queries={[]} onQueriesChange={vi.fn()} onUse={vi.fn()} onClose={vi.fn()} />)
    edit("JSON query", '{"operation":"services"}')
    fireEvent.click(screen.getByRole("button", { name: "Run query" }))
    await screen.findByTestId("result")
    fireEvent.click(screen.getByRole("combobox", { name: "Explore record visualization" }))
    fireEvent.click(screen.getByRole("option", { name: "Record bar chart" }))
    expect(screen.getByText("Choose the result columns to preview this visualization.")).toBeInTheDocument()
    expect(screen.getByLabelText("Result summary")).toHaveTextContent("1 row · 2 columns returned")
    expect(screen.getByLabelText("Result summary")).toHaveTextContent("Partial provider response")
    expect(screen.queryByTestId("result")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("combobox", { name: "Preview x column" }))
    fireEvent.click(screen.getByRole("option", { name: "service" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Preview value column" }))
    expect(screen.queryByRole("option", { name: "service" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: "count" }))
    expect(screen.getByTestId("result")).toHaveAttribute("data-widget", "records-bar")
    expect(JSON.parse(screen.getByTestId("result").getAttribute("data-config")!)).toEqual({ x: "service", y: ["count"] })
    expect(api.query).toHaveBeenCalledTimes(1)
  })

  it("runs and saves a PostgreSQL records template with hostile filter data bound outside SQL", async () => {
    const api = client(), onQueriesChange = vi.fn()
    const pg: Provider = { id: "pg", name: "Application database", type: "postgresql", capabilities: ["records", "metrics"], transport: "mcp" }
    const stored: SavedQueryEntry = { schemaVersion: 1, id: "sql-records", name: "SQL records", providerId: "pg", kind: "records", query: '{"sql":"SELECT name FROM events WHERE service=$1","parameters":[{{service}}]}', parameters: [{ name: "service", type: "string", defaultValue: "api" }], etag: '"pg-v1"' }
    render(<Explorer client={api} providers={[pg]} queries={[stored]} onQueriesChange={onQueriesChange} onUse={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole("combobox", { name: "Open saved query" }))
    fireEvent.click(await screen.findByRole("option", { name: /SQL records/ }))
    await screen.findByDisplayValue("SQL records")
    expect(screen.getByText("query_records")).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "PromQL query" })).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "SQL metric projection" })).not.toBeInTheDocument()
    const hostile = "api'); DROP TABLE events; --"
    edit("Test value for service", hostile)
    fireEvent.click(screen.getByRole("button", { name: "Run query" }))
    await waitFor(() => expect(api.query).toHaveBeenCalledTimes(1))
    const request = vi.mocked(api.query).mock.calls[0][0]
    expect(request.kind).toBe("records")
    expect(JSON.parse(request.query)).toEqual({ sql: "SELECT name FROM events WHERE service=$1", parameters: [hostile] })
    expect(screen.getByTestId("result")).toHaveAttribute("data-widget", "record-table")
    expect(screen.getByTestId("result")).toHaveAttribute("data-kind", "records")
    edit("Query description", "Rows from the selected service")
    fireEvent.click(screen.getByRole("button", { name: "Save query" }))
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledWith(expect.objectContaining({ query: stored.query, description: "Rows from the selected service" }), stored.etag))
    edit("SQL query", "SELECT {{service}}")
    expect(screen.getByRole("button", { name: "Run query" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save query" })).toBeDisabled()
    expect(api.metadata).not.toHaveBeenCalled()
  })

  it("edits description, tags and typed parameters in separate tabs without hiding the query or running it", async () => {
    const api = client();
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Query description")).toBeVisible();
    expect(screen.getByLabelText("New tag")).toBeVisible();
    expect(screen.getByLabelText("Parameter 1 name")).not.toBeVisible();
    edit("Query description", "Requests across services.\nUse with a service dashboard filter.");
    edit("New tag", "service-health");
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    fireEvent.click(screen.getByRole("tab", { name: /Parameters/ }));
    expect(screen.getByLabelText("Query description")).not.toBeVisible();
    expect(screen.getByLabelText("Parameter 1 name")).toBeVisible();
    edit("Parameter 2 default", "2.5");
    fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
    edit("Cover image", "/images/services.png");
    edit("New metadata key", "team");
    edit("New metadata value", "platform");
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByLabelText("Query description")).toHaveValue("Requests across services.\nUse with a service dashboard filter.");
    expect(screen.getByRole("button", { name: "Remove tag service-health" })).toBeVisible();
    expect(screen.getByLabelText("PromQL query")).toBeVisible();
    expect(screen.getByRole("region", { name: "Explore query results" })).toBeVisible();
    expect(api.query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Requests across services.\nUse with a service dashboard filter.",
        tags: ["service-health"], imageUrl: "/images/services.png", metadata: { team: "platform" },
        parameters: [saved.parameters![0], { name: "factor", type: "number", defaultValue: 2.5 }],
      }), saved.etag,
    ));
  });
  it("reports draft dirtiness even while the workspace is inactive and clears it after saving", async () => {
    const api = client(), onDirtyChange = vi.fn();
    const props = { client: api, providers, queries: [], onQueriesChange: vi.fn(), onUse: vi.fn(), onClose: vi.fn(), onDirtyChange };
    const { rerender } = render(<Explorer {...props} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    edit("Query name", "Unsaved availability");
    edit("PromQL query", "up");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    rerender(<Explorer {...props} active={false} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    rerender(<Explorer {...props} active />);
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
  it("reports dashboard capacity errors without losing the saved query", async () => {
    const onUse = vi.fn<(query: SavedQuery) => void>(() => {
      throw new Error("A dashboard supports up to 48 widgets.");
    });
    render(<Harness api={client()} initial={[saved]} onUse={onUse} />);
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Use in dashboard" }));
    expect(screen.getByRole("alert")).toHaveTextContent("48 widgets");
    expect(screen.getByLabelText("Query name")).toHaveValue("Availability");
    expect(onUse.mock.calls[0][0]).not.toHaveProperty("etag");
    expect(screen.queryByRole("button", { name: "Save as new query" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load latest saved version" })).not.toBeInTheDocument();
  });
  it("adopts a same-content query revision without resetting a clean editor", async () => {
    const api = client();
    const props = { client: api, providers, onQueriesChange: vi.fn(), onUse: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<Explorer {...props} queries={[saved]} />);
    await openSaved();
    edit("Test value for factor", "7");
    rerender(<Explorer {...props} queries={[{ ...saved, etag: '\"same-content-v2\"' }]} />);
    await waitFor(() => expect(screen.queryByText(/changed or was removed elsewhere/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Test value for factor")).toHaveValue("7");
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id }), '\"same-content-v2\"'));
  });
  it("retains a dirty query's ETag after a same-content remote rewrite", async () => {
    const api = client();
    const props = { client: api, providers, onQueriesChange: vi.fn(), onUse: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<Explorer {...props} queries={[saved]} />);
    await openSaved();
    edit("Query name", "My query draft");
    rerender(<Explorer {...props} queries={[{ ...saved, etag: '\"same-content-v2\"' }]} />);
    expect(await screen.findByText(/changed or was removed elsewhere/)).toBeVisible();
    expect(screen.getByLabelText("Query name")).toHaveValue("My query draft");
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledWith(expect.objectContaining({ name: "My query draft" }), saved.etag));
  });
  it("does not link an outdated selected definition after a library refresh", async () => {
    const props = {
      client: client(),
      providers,
      onQueriesChange: vi.fn(),
      onUse: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<Explorer {...props} queries={[saved]} />);
    await openSaved();
    rerender(
      <Explorer
        {...props}
        queries={[
          {
            ...saved,
            parameters: [{ name: "new_parameter", type: "string" }],
            etag: '"v2"',
          },
        ]}
      />,
    );
    expect(within(screen.getByRole("region", { name: "Save query" })).getByRole("status")).toHaveTextContent(
      "changed or was removed",
    );
    expect(
      screen.getByRole("button", { name: "Use in dashboard" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: /Parameters/ }));
    expect(screen.getByLabelText("Parameter 1 name")).toHaveValue("service");
  });
  it("runs only explicitly and preserves executed results while the draft changes", async () => {
    const api = client();
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    expect(api.query).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByTestId("result")).toHaveTextContent("up");
    expect(api.query).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "prom",
        query: "up",
        kind: "metrics",
      }),
      expect.any(AbortSignal),
    );
    edit("PromQL query", "rate(requests_total[5m])");
    expect(api.query).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("result")).toHaveTextContent(/^up$/);
    expect(within(screen.getByRole("region", { name: "Explore query results" })).getByText(/Inputs changed/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use in dashboard" }),
    ).toBeDisabled();
  });
  it("identifies the last successful result when an unchanged rerun fails", async () => {
    const api = client();
    vi.mocked(api.query).mockResolvedValueOnce({ series: [{ name: "up", labels: {}, points: [{ timestamp: 1000, value: 0 }, { timestamp: 2000, value: null }] }], truncated: true }).mockRejectedValueOnce(new Error("Provider unavailable"));
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByTestId("result");
    expect(screen.getByLabelText("Result summary")).toHaveTextContent("1 series · 2 samples · 1 missing sample");
    expect(screen.getByLabelText("Result summary")).toHaveTextContent("Partial provider response");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Showing the previous successful result");
    expect(screen.getByTestId("result")).toHaveTextContent("up");
  });
  it("explains a first-run failure and clears it when test inputs change", async () => {
    const api = client();
    vi.mocked(api.query).mockRejectedValueOnce(new Error("Provider unavailable"));
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByRole("heading", { name: "Query failed" })).toBeInTheDocument();
    expect(screen.queryByText("Ready when you are")).not.toBeInTheDocument();
    edit("Test value for service", "payments");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Ready when you are")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset test value" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("identifies an earlier result when the changed-input run fails", async () => {
    const api = client();
    vi.mocked(api.query).mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("Provider unavailable"));
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByTestId("result");
    edit("Test value for service", "payments");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(screen.getByText("Latest run failed. Showing the previous result for different inputs.")).toBeInTheDocument();
    edit("Test value for service", "orders");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Inputs changed. Showing the previous result/)).toBeInTheDocument();
  });
  it("keeps test inputs separate from typed saved defaults and uses ETags", async () => {
    const api = client();
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    edit("Test value for service", 'checkout"blue');
    edit("Test value for factor", "2.5");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByTestId("result");
    expect(api.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'up{service="checkout\\"blue"} * 2.5' }),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalled());
    expect(api.saveSavedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: saved.parameters }),
      '"v1"',
    );
    expect(vi.mocked(api.saveSavedQuery).mock.calls[0][0]).not.toHaveProperty(
      "etag",
    );
    fireEvent.click(screen.getByRole("tab", { name: /Parameters/ }));
    expect(screen.getByLabelText("Parameter 1 default")).toHaveValue("api");
  });
  it("does not send requests with missing or invalid parameter values and preserves the draft", async () => {
    const api = client();
    render(
      <Harness
        api={api}
        initial={[
          {
            ...saved,
            parameters: [
              { name: "service", type: "string" },
              { name: "factor", type: "number" },
            ],
          },
        ]}
      />,
    );
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Set a value");
    edit("Test value for service", "api");
    edit("Test value for factor", "1 or vector(99)");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("finite number");
    expect(api.query).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Test value for factor")).toHaveValue(
      "1 or vector(99)",
    );
  });
  it("cancels on draft edits and ignores late outcomes from a fetcher that does not obey abort", async () => {
    const api = client(),
      first = deferred<QueryResult>();
    vi.mocked(api.query).mockReturnValueOnce(first.promise);
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    const signal = vi.mocked(api.query).mock.calls[0][1];
    edit("PromQL query", "process_cpu_seconds_total");
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(result));
    expect(screen.queryByTestId("result")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run query" })).toBeEnabled();
  });
  it("acknowledges an explicit cancellation and clears the notice on editing", async () => {
    const api = client(), pending = deferred<QueryResult>();
    vi.mocked(api.query).mockReturnValueOnce(pending.promise);
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel query" }));
    expect(screen.getByText("Query cancelled.")).toBeInTheDocument();
    expect(vi.mocked(api.query).mock.calls[0][1].aborted).toBe(true);
    edit("PromQL query", "up == 1");
    expect(screen.queryByText("Query cancelled.")).not.toBeInTheDocument();
  });
  it("labels the retained result after a rerun is cancelled and ignores late data", async () => {
    const api = client(), pending = deferred<QueryResult>();
    vi.mocked(api.query).mockResolvedValueOnce(result).mockReturnValueOnce(pending.promise);
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByTestId("result");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(screen.getByText(/Running query… Showing the previous successful result/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel query" }));
    expect(screen.getByText("Query cancelled. Showing the previous successful result below.")).toBeInTheDocument();
    await act(async () => pending.resolve({ series: [{ name: "late", labels: {}, points: [{ timestamp: 1, value: 42 }] }] }));
    expect(screen.getByLabelText("Result summary")).toHaveTextContent("0 series · 0 samples returned");
  });
  it("a canceled old rejection cannot replace a newer successful result", async () => {
    const api = client(),
      first = deferred<QueryResult>();
    vi.mocked(api.query).mockReturnValueOnce(first.promise);
    render(<Harness api={api} />);
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel query" }));
    edit("PromQL query", "up == 1");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByTestId("result");
    await act(async () => first.reject(new Error("Old failure")));
    expect(screen.queryByText("Old failure")).not.toBeInTheDocument();
    expect(screen.getByTestId("result")).toHaveTextContent("up == 1");
  });
  it("aborts when hidden while preserving an unsaved query across workspaces", async () => {
    const api = client(),
      request = deferred<QueryResult>();
    vi.mocked(api.query).mockReturnValue(request.promise);
    const { rerender } = render(<Harness api={api} />);
    edit("Query name", "Unsaved");
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Run query" }));
    rerender(<Harness api={api} active={false} />);
    expect(vi.mocked(api.query).mock.calls[0][1].aborted).toBe(true);
    await act(async () => request.resolve(result));
    rerender(<Harness api={api} active />);
    expect(screen.getByLabelText("Query name")).toHaveValue("Unsaved");
    expect(screen.queryByTestId("result")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run query" })).toBeEnabled();
  });
  it("retains draft and ETag on conflict and offers explicit reload or separate-copy recovery", async () => {
    const api = client();
    vi.mocked(api.saveSavedQuery).mockRejectedValue(
      new Error("Changed by another editor"),
    );
    vi.mocked(api.getSavedQuery).mockResolvedValue({
      query: {
        schemaVersion: 1,
        id: saved.id,
        providerId: saved.providerId,
        kind: saved.kind,
        query: saved.query,
        parameters: saved.parameters,
        name: "Newer remote name",
      },
      etag: '"remote"',
    });
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    edit("Query name", "My local name");
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Changed by another editor",
    );
    expect(screen.getByLabelText("Query name")).toHaveValue("My local name");
    expect(
      screen.getByRole("button", { name: "Load latest saved version" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Save as new query" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Use in dashboard" }),
    ).toBeDisabled();
  });
  it("recovers an exact saved document after a lost save response without creating duplicates", async () => {
    const api = client();
    vi.mocked(api.saveSavedQuery).mockImplementation(async (query) => {
      vi.mocked(api.getSavedQuery).mockResolvedValue({
        query,
        etag: '"committed"',
      });
      throw new Error("Response lost");
    });
    render(<Harness api={api} />);
    edit("Query name", "Service availability");
    edit("PromQL query", "up");
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    expect(await within(screen.getByRole("region", { name: "Save query" })).findByRole("status")).toHaveTextContent("Query saved");
    expect(api.saveSavedQuery).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Use in dashboard" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.saveSavedQuery).mock.calls[1][1]).toBe('"committed"');
  });
  it("requires a deliberate dirty-draft decision before changing data sources", async () => {
    render(<Harness api={client()} />);
    edit("PromQL query", "up");
    const select = screen.getByRole("combobox", {
      name: "Explore data source",
    });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: /Production traces/ }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "Discard query changes",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(queryValue("PromQL query")).toBe("up");
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: /Production traces/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard changes" }),
    );
    await screen.findByLabelText("TraceQL query");
    expect(queryValue("TraceQL query")).toBe("");
  });
  it("deletes with the current ETag only after confirmation", async () => {
    const api = client();
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Delete query" }));
    expect(api.removeSavedQuery).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete saved query" }),
    );
    await waitFor(() =>
      expect(api.removeSavedQuery).toHaveBeenCalledWith(saved.id, '"v1"'),
    );
    expect(await within(screen.getByRole("region", { name: "Save query" })).findByRole("status")).toHaveTextContent(
      "Saved query deleted",
    );
  });
  it("preserves an in-use query after blocked deletion without unrelated save recovery actions", async () => {
    const api = client();
    vi.mocked(api.removeSavedQuery).mockRejectedValue(new Error("Saved dashboards still use this query. Remove their references first."));
    render(<Harness api={api} initial={[saved]} />);
    await openSaved();
    fireEvent.click(screen.getByRole("button", { name: "Delete query" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete saved query" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove their references first");
    expect(screen.getByLabelText("Query name")).toHaveValue("Availability");
    expect(screen.queryByRole("button", { name: "Save as new query" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load latest saved version" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete query" })).toBeEnabled();
  });
});
