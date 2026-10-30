import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MetricDetails } from "./metric-tooltip-content";
import type { Widget } from "./schema";
afterEach(cleanup);
const widget: Widget = { id: "test", title: "Request latency", type: "stat", providerId: "prom", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 3, h: 1 } };
const series = { name: 'latency{service="api"}', labels: { service: "api" }, points: [{ timestamp: 1000, value: 123.456 }] };
it("uses a friendly heading while preserving raw source and exact unit/value secondary", () => {
  const { container } = render(<MetricDetails widget={widget} series={series} index={0} point={series.points[0]} unit="ms" />);
  expect(screen.getByText("Request latency")).toBeVisible();
  expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(container.querySelector("details")).toHaveTextContent('latency{service="api"}');
  expect(container.querySelector("details")).toHaveTextContent("123.456 ms");
  expect(container.querySelector("time")).toHaveAttribute("datetime", "1970-01-01T00:00:01.000Z");
});
it("formats only tooltip presentation without modifying canonical observations", () => {
  const before = JSON.stringify(series);
  const { container } = render(<MetricDetails widget={{ ...widget, options: { tooltipTitle: "Latency budget", tooltipValueLabel: "Observed", tooltipDecimals: 1, tooltipShowUnit: false } }} series={series} index={0} point={series.points[0]} unit="ms" />);
  expect(screen.getByText("Latency budget")).toBeVisible();
  expect(screen.getByText("Observed")).toBeVisible();
  expect(container.querySelector('[data-metric-value="123.456"]')).toHaveTextContent("123.5");
  expect(container.querySelector("details")).toHaveTextContent("123.456 ms");
  expect(JSON.stringify(series)).toBe(before);
});

it("inherits widget decimals when a shared consumer has no explicit override", () => {
  const { container } = render(<MetricDetails widget={{...widget,options:{decimals:2}}} series={series} index={0} point={series.points[0]} unit="ms" />);
  expect(container.querySelector('[data-metric-value="123.456"]')).toHaveTextContent("123.46 ms");
  expect(container.querySelector("details")).toHaveTextContent("123.456 ms");
});
