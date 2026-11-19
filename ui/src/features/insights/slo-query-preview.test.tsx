import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SloQueryPreview } from "./slo-query-preview";
import { compileSloQuery } from "./slo";

const valid = JSON.stringify({ objective: 99.9, period: "30d", total: "http_requests_total", bad: 'http_requests_total{code="5xx"}' });

afterEach(cleanup);

describe("SloQueryPreview", () => {
  it("shows the query compiled from the config as read-only text", () => {
    render(<SloQueryPreview config={valid} />);
    expect(screen.getByLabelText("Generated PromQL")).toHaveTextContent(compileSloQuery(JSON.parse(valid)));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says why an invalid config has no query", () => {
    render(<SloQueryPreview config={JSON.stringify({ objective: 120 })} />);
    expect(screen.getByRole("status")).toHaveTextContent("invalid_");
  });
});
