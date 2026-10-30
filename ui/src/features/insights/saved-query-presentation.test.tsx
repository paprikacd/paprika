import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { GammaSelect } from "./gamma/select";
import { savedQueryOption } from "./saved-query-presentation";
import type { SavedQuery } from "./schema";

const query: SavedQuery = {
  schemaVersion: 1, id: "requests", name: "Service requests", providerId: "metrics", kind: "metrics", query: "up",
  description: "Request volume across production services", tags: ["production", "critical", "requests", "platform"], metadata: { team: "observability" },
};

describe("saved query presentation", () => {
  it("keeps tags visible in both rich options and the selected context", () => {
    function Host() {
      const [value, setValue] = useState("");
      return <GammaSelect aria-label="Saved query" value={value} options={[savedQueryOption(query)]} onValueChange={setValue} searchable />;
    }
    render(<Host />);
    const trigger = screen.getByRole("combobox", { name: "Saved query" });
    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "Service requests" });
    expect(within(option).getByText("production", { exact: true })).toBeVisible();
    expect(within(option).getByText("critical", { exact: true })).toBeVisible();
    expect(option).toHaveAccessibleDescription(/Request volume.*production.*critical.*observability/);
    fireEvent.click(option);
    expect(within(trigger).getByText("production", { exact: true })).toBeVisible();
    expect(within(trigger).getByText("critical", { exact: true })).toBeVisible();
    expect(within(trigger).getByText("+2")).toHaveAttribute("title", "requests, platform");
    expect(trigger).toHaveAccessibleDescription(/Tags: production, critical, requests, platform/);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not fabricate tags or reserve empty selected context for untagged queries", () => {
    const option = savedQueryOption({ ...query, tags: undefined, metadata: undefined });
    expect(option.selectedDetails).toBeUndefined();
    render(<GammaSelect aria-label="Saved query" value={query.id} options={[option]} onValueChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Saved query" })).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("production", { exact: true })).not.toBeInTheDocument();
  });

  it("uses the query data kind instead of guessing a provider language", () => {
    const withoutDescription = { ...query, description: undefined, tags: undefined, metadata: undefined };
    expect(savedQueryOption({ ...withoutDescription, kind: "metrics", providerId: "postgresql" }).description).toBe("Metrics · 0 parameters");
    expect(savedQueryOption({ ...withoutDescription, kind: "records", providerId: "postgresql", parameters: [{ name: "service", type: "string" }] }).description).toBe("Records · 1 parameter");
    expect(savedQueryOption({ ...withoutDescription, kind: "traces", providerId: "cloudtrace" }).description).toBe("Traces · 0 parameters");
  });
});
