import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  SavedQueryBindingEditor,
  SavedQueryPicker,
} from "./saved-query-controls";
import type { SavedQuery, SavedQueryBinding } from "./schema";

const query: SavedQuery = {
  schemaVersion: 1,
  id: "q",
  name: "Availability",
  providerId: "prom",
  kind: "metrics",
  query: "up{service={{service}}} * {{factor}}",
  parameters: [
    { name: "service", type: "string", defaultValue: "api" },
    { name: "factor", type: "number" },
  ],
};
function Harness({ allowObservation = false }: { allowObservation?: boolean }) {
  const [bindings, setBindings] = useState<SavedQueryBinding[]>([]);
  return (
    <>
      <SavedQueryBindingEditor
        query={query}
        bindings={bindings}
        onChange={setBindings}
        variables={[{ name: "service" }]}
        allowObservation={allowObservation}
      />
      <output>{JSON.stringify(bindings)}</output>
    </>
  );
}
function select(name: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}
describe("shared saved query controls", () => {
  it("finds a saved query by its stable ID when its display name differs", () => {
    const onChange = vi.fn();
    render(<SavedQueryPicker queries={[{ ...query, id: "availability-prod-v2" }]} kind="metrics" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Saved query" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search saved query" }), { target: { value: "availability-prod-v2" } });
    fireEvent.click(screen.getByRole("option", { name: /Availability/ }));
    expect(onChange).toHaveBeenCalledWith("availability-prod-v2");
  });
  it("filters compatible definitions without hiding an unavailable current reference", () => {
    render(
      <SavedQueryPicker
        queries={[
          query,
          {
            ...query,
            id: "other",
            providerId: "other",
            name: "Other provider",
          },
          { ...query, id: "trace", kind: "traces", name: "Trace query" },
        ]}
        kind="metrics"
        providerId="prom"
        value="missing"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Saved query" }),
    ).toHaveTextContent("Unavailable saved query");
    fireEvent.click(screen.getByRole("combobox", { name: "Saved query" }));
    expect(screen.getByRole("option", { name: /Availability/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /Other provider|Trace query/ }),
    ).not.toBeInTheDocument();
  });
  it("keeps defaults implicit and creates explicit dashboard variable bindings", () => {
    render(<Harness />);
    expect(screen.getByText(/Saved default:/)).toHaveTextContent('"api"');
    expect(screen.getByText(/Required: bind/)).toBeVisible();
    select("Value for service from", "Dashboard variable");
    expect(screen.getByRole("status")).toHaveTextContent(
      '"source":"variable","variable":"service"',
    );
    select("Value for service from", "Saved default");
    expect(screen.getByRole("status")).toHaveTextContent("[]");
  });
  it("preserves invalid numeric text for validation and emits finite typed constants", () => {
    render(<Harness />);
    select("Value for factor from", "Fixed value");
    fireEvent.change(screen.getByLabelText("Fixed value for factor"), {
      target: { value: "1e" },
    });
    expect(screen.getByRole("status")).toHaveTextContent('"value":"1e"');
    fireEvent.change(screen.getByLabelText("Fixed value for factor"), {
      target: { value: "1.25" },
    });
    expect(screen.getByRole("status")).toHaveTextContent('"value":1.25');
  });
  it("limits observation sources to tooltips and matches typed observation fields", () => {
    const { unmount } = render(<Harness />);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Value for factor from" }),
    );
    expect(
      screen.queryByRole("option", { name: /Observation/ }),
    ).not.toBeInTheDocument();
    unmount();
    render(<Harness allowObservation />);
    select("Value for factor from", "Observation timestamp");
    expect(screen.getByRole("status")).toHaveTextContent('"field":"timestamp"');
    expect(screen.getByText(/Unix seconds/)).toBeVisible();
    select("Value for service from", "Observation label");
    fireEvent.change(screen.getByLabelText("Observation label for service"), {
      target: { value: "deployment" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      '"label":"deployment"',
    );
  });
  it("keeps obsolete bindings visible until explicitly removed", () => {
    const onChange = vi.fn();
    render(
      <SavedQueryBindingEditor
        query={query}
        bindings={[{ parameter: "removed", source: "constant", value: "x" }]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/no longer exists/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove obsolete binding" }),
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
