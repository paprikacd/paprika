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

it("places the sample time before expandable source metadata and retains the full identity", () => {
  const { container } = render(<MetricDetails widget={widget} series={series} index={0} point={series.points[0]} unit="ms" seriesLabel="API" />);
  const time = container.querySelector("time")!;
  const details = container.querySelector("details")!;
  expect(time.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("API")).toBeVisible();
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveTextContent(series.name);
  expect(details).toHaveTextContent("123.456 ms");
});
it("reads the headline at reading precision and keeps the exact value in Source details", () => {
  const noisy = { name: "latency{service=\"api\"}", labels: { service: "api" }, points: [{ timestamp: 1000, value: 5.878749999999975 }] };
  const { container } = render(<MetricDetails widget={{ ...widget, unit: "observations/s" }} series={noisy} index={0} point={noisy.points[0]} unit="observations/s" />);
  expect(container.querySelector('[data-metric-value="5.878749999999975"]')).toHaveTextContent("5.88 observations/s");
  expect(container.querySelector("details")).toHaveTextContent("5.87875 observations/s");
});
it("keeps the subject visible on the series line when an authored tooltip title replaces the heading", () => {
  const { container } = render(<MetricDetails widget={{ ...widget, options: { tooltipTitle: "Custom CPU title" } }} series={series} index={0} point={series.points[0]} unit="ms" subject="node-03" seriesLabel="Node CPU" />);
  expect(screen.getByText("Custom CPU title")).toBeVisible();
  expect(container.querySelector(".tooltipSeries, [class*='tooltipSeries']")).toHaveTextContent("node-03");
  expect(screen.getByText("Node CPU")).toBeVisible();
});
