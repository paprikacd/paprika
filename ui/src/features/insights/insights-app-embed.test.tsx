import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InsightsClient } from "./client";
import InsightsApp from "./insights-app";

vi.mock("./embed-view", () => ({
  EmbedView: ({ embed }: { embed: { widgetId: string } }) => <p>embed {embed.widgetId}</p>,
}));

describe("Insights page in embed mode", () => {
  it("renders only the embed, so the workspace and its loads never start", () => {
    const client = new Proxy({}, { get: (_, name) => vi.fn(() => { throw new Error(`workspace called ${String(name)}`); }) }) as InsightsClient;
    const { container } = render(<InsightsApp client={client} embed={{ widgetId: "requests", theme: "light" }} />);
    expect(screen.getByText("embed requests")).toBeInTheDocument();
    expect(container.querySelectorAll("nav, aside, header, button")).toHaveLength(0);
  });
});
