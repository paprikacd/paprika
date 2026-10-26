import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrilldownEditor } from "./drilldown-editor";
import { widgetSchema, type Dashboard, type Widget } from "./schema";

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
}: {
  initial?: Widget;
  targets?: Dashboard[];
  onChange?: (widget: Widget) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <DrilldownEditor
      widget={draft}
      dashboards={targets}
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

  it("prevents duplicate target bindings and removes incompatible bindings when changing destination", () => {
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
