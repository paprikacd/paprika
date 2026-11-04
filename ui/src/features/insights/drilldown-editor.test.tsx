import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrilldownEditor } from "./drilldown-editor";
import { widgetSchema, type Dashboard, type Widget } from "./schema";
import type { QueryFields } from "./query-connections";

const widget: Widget = {
  id: "health",
  title: "Service health",
  type: "heatmap",
  query: "up",
  providerId: "prometheus",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};
const dashboards: Dashboard[] = [
  {
    schemaVersion: 1,
    id: "service",
    title: "Service detail",
    timeRange: "1h",
    refreshInterval: 30,
    widgets: [],
    variables: [
      { name: "service", label: "Service" },
      { name: "region", label: "Region", defaultValue: "west" },
    ],
  },
  {
    schemaVersion: 1,
    id: "region",
    title: "Region detail",
    timeRange: "1h",
    refreshInterval: 30,
    widgets: [],
    variables: [{ name: "region", label: "Region" }],
  },
];

function Harness({
  initial = widget,
  targets = dashboards,
  onChange = vi.fn(),
  fields,
}: {
  initial?: Widget;
  targets?: Dashboard[];
  onChange?: (widget: Widget) => void;
  fields?: QueryFields;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <DrilldownEditor
      widget={draft}
      dashboards={targets}
      queryFields={fields}
      onChange={(value) => {
        setDraft(value);
        onChange(value);
      }}
    />
  );
}
function choose(label: string, name: string | RegExp) {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name }));
  expect(trigger).toHaveFocus();
}
function addBinding() {
  fireEvent.click(
    screen.getByRole("button", { name: "Add variable binding to link 1" }),
  );
}

describe("dashboard drilldown editor", () => {
  it("suggests loaded metric label keys and explains incomplete series coverage", () => {
    const fields: QueryFields = { seriesCount: 3, labels: [{ name: "node", samples: ["node-01"], present: 3 }, { name: "zone", samples: [], present: 2 }], partial: false };
    render(<Harness fields={fields} />);
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard link" }));
    addBinding();
    const input = screen.getByLabelText("Link 1 binding 1 label key") as HTMLInputElement;
    expect([...input.list!.options].map(option => option.value)).toEqual(["node", "zone"]);
    expect(screen.getByText(/Available result labels: node, zone/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "zone" } });
    expect(screen.getByText(/zone.*2 of 3 loaded series/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText(/no.*missing.*label/i)).toBeInTheDocument();
  });

  it("suggests record columns and does not claim missing fields for a partial result", () => {
    const fields: QueryFields = { seriesCount: 0, labels: [], partial: true, recordColumns: [{ name: "ticker", type: "string" }, { name: "sector", type: "string" }] };
    render(<Harness fields={fields} />);
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard link" }));
    addBinding();
    const input = screen.getByLabelText("Link 1 binding 1 label key") as HTMLInputElement;
    expect([...input.list!.options].map(option => option.value)).toEqual(["ticker", "sector"]);
    fireEvent.change(input, { target: { value: "other" } });
    expect(screen.queryByText(/no.*other.*field/i)).not.toBeInTheDocument();
    expect(screen.getByText(/limited result/i)).toBeInTheDocument();
  });
  it("creates a bounded valid link and configures label, numeric, series and constant bindings through Gamma controls", () => {
    const changed = vi.fn();
    const { container } = render(<Harness onChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard link" }));
    fireEvent.change(screen.getByLabelText("Link 1 title"), {
      target: { value: "Inspect service" },
    });
    addBinding();
    fireEvent.change(screen.getByLabelText("Link 1 binding 1 label key"), {
      target: { value: "service_name" },
    });
    expect(changed.mock.lastCall?.[0].drilldowns[0]).toMatchObject({
      title: "Inspect service",
      dashboardId: "service",
      carryTimeRange: true,
      bindings: [
        { variable: "service", source: "label", value: "service_name" },
      ],
    });
    choose("Link 1 binding 1 source", /^Value /);
    expect(changed.mock.lastCall?.[0].drilldowns[0].bindings).toEqual([
      { variable: "service", source: "value" },
    ]);
    choose("Link 1 binding 1 source", /^Series name/);
    expect(changed.mock.lastCall?.[0].drilldowns[0].bindings).toEqual([
      { variable: "service", source: "series" },
    ]);
    choose("Link 1 binding 1 source", /^Constant/);
    fireEvent.change(screen.getByLabelText("Link 1 binding 1 constant value"), {
      target: { value: 'api" or 1 == 1' },
    });
    fireEvent.click(screen.getByRole("switch", { name: /^Carry time range/ }));
    const result = changed.mock.lastCall?.[0];
    expect(result.drilldowns[0]).toMatchObject({
      carryTimeRange: false,
      bindings: [
        { variable: "service", source: "constant", value: 'api" or 1 == 1' },
      ],
    });
    expect(widgetSchema.safeParse(result).success).toBe(true);
    expect(container.querySelector("select")).toBeNull();
  });

  it("prevents duplicate bindings and asks before a destination change removes incompatible bindings", () => {
    const changed = vi.fn();
    render(<Harness onChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard link" }));
    addBinding();
    addBinding();
    expect(
      screen.getByRole("button", { name: "Add variable binding to link 1" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }),
    );
    expect(screen.getByRole("option", { name: /^Region/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }),
      { key: "Escape" },
    );
    choose("Link 1 destination", /^Region detail/);
    expect(screen.getByRole("combobox", { name: "Link 1 destination" })).toHaveTextContent("Service detail");
    expect(screen.getByText(/service.*removed/i)).toBeVisible();
    expect(changed.mock.lastCall?.[0].drilldowns[0].bindings).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Keep current destination" }));
    expect(screen.getByRole("combobox", { name: "Link 1 destination" })).toHaveFocus();
    expect(screen.queryByText(/service.*removed/i)).toBeNull();
    expect(changed.mock.lastCall?.[0].drilldowns[0].bindings).toHaveLength(2);
    choose("Link 1 destination", /^Region detail/);
    fireEvent.click(screen.getByRole("button", { name: "Remove incompatible bindings and switch" }));
    expect(screen.getByRole("combobox", { name: "Link 1 destination" })).toHaveFocus();
    expect(changed.mock.lastCall?.[0].drilldowns[0].bindings).toEqual([
      { variable: "region", source: "label", value: "region" },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove link 1 binding 1" }),
    );
    expect(
      screen.getByRole("button", { name: "Add variable binding to link 1" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove link 1" }));
    expect(changed.mock.lastCall?.[0].drilldowns).toBeUndefined();
  });

  it("switches immediately when all bindings are compatible", () => {
    const changed = vi.fn();
    render(<Harness onChange={changed} initial={{ ...widget, drilldowns: [{ id: "a", title: "Inspect", dashboardId: "service", bindings: [{ variable: "region", source: "label", value: "region" }] }] }} />);
    choose("Link 1 destination", /^Region detail/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(changed.mock.lastCall?.[0].drilldowns[0]).toMatchObject({ dashboardId: "region", bindings: [{ variable: "region", source: "label", value: "region" }] });
  });

  it("does not drop bindings if the pending destination disappears", () => {
    const changed = vi.fn();
    const initial: Widget = { ...widget, drilldowns: [{ id: "a", title: "Inspect", dashboardId: "service", bindings: [{ variable: "service", source: "label", value: "service" }] }] };
    const { rerender } = render(<Harness onChange={changed} initial={initial} />);
    choose("Link 1 destination", /^Region detail/);
    rerender(<Harness onChange={changed} initial={initial} targets={[dashboards[0]]} />);
    expect(screen.getByText(/selected destination is no longer available/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Switch destination" })).toBeDisabled();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep current destination" }));
    expect(screen.getByRole("combobox", { name: "Link 1 destination" })).toHaveTextContent("Service detail");
  });

  it("rechecks destination variables before confirming a pending change", () => {
    const changed = vi.fn();
    const initial: Widget = { ...widget, drilldowns: [{ id: "a", title: "Inspect", dashboardId: "service", bindings: [{ variable: "service", source: "label", value: "service" }] }] };
    const { rerender } = render(<Harness onChange={changed} initial={initial} />);
    choose("Link 1 destination", /^Region detail/);
    rerender(<Harness onChange={changed} initial={initial} targets={[dashboards[0], { ...dashboards[1], variables: [{ name: "service" }] }]} />);
    expect(screen.getByText(/will keep the remaining variable bindings/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Switch destination" }));
    expect(changed.mock.lastCall?.[0].drilldowns[0]).toMatchObject({ dashboardId: "region", bindings: [{ variable: "service", source: "label", value: "service" }] });
  });

  it("keeps missing destinations and variables visible with a way to repair each", () => {
    render(
      <Harness
        initial={{
          ...widget,
          drilldowns: [
            {
              id: "missing",
              title: "Missing",
              dashboardId: "deleted",
              bindings: [
                { variable: "old_service", source: "label", value: "service" },
              ],
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Link 1 destination" }),
    ).toHaveTextContent("Unavailable: deleted");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Add variable binding to link 1" }),
    ).toBeDisabled();
    choose("Link 1 destination", /^Service detail/);
    expect(screen.getByText(/old_service.*removed/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove incompatible bindings and switch" }));
    expect(screen.queryByRole("alert")).toBeNull();
    addBinding();
    expect(
      screen.getByRole("combobox", { name: "Link 1 binding 1 variable" }),
    ).toHaveTextContent("Service");
  });

  it("limits each widget to eight links, supports no-variable destinations and prevents adding without a destination", () => {
    const { rerender } = render(<Harness targets={[]} />);
    expect(
      screen.getByRole("button", { name: "Add dashboard link" }),
    ).toBeDisabled();
    rerender(
      <Harness targets={[{ ...dashboards[0], variables: undefined }]} />,
    );
    for (let index = 0; index < 8; index++)
      fireEvent.click(
        screen.getByRole("button", { name: "Add dashboard link" }),
      );
    expect(
      screen.getByRole("button", { name: "Add dashboard link" }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/This destination has no variables/),
    ).toHaveLength(8);
    const first = screen.getByRole("group", { name: "Link 1" });
    expect(
      within(first).getByRole("button", {
        name: "Add variable binding to link 1",
      }),
    ).toBeDisabled();
  });
});
