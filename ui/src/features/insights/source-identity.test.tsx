import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProviderStateMarker, providerOption, providerTypeLabel } from "./source-identity"
import type { Provider } from "./schema"

const base = (type: Provider["type"], capabilities: Provider["capabilities"] = ["metrics"]): Provider => ({
  id: `${type}-1`, name: `${type} source`, type, capabilities,
})

describe("provider picker identity", () => {
  it("labels every admitted provider type, including the synthetic mock", () => {
    expect(providerOption(base("prometheus")).description).toMatch(/^Prometheus · metrics/)
    expect(providerOption(base("tempo", ["traces"])).description).toMatch(/^Tempo · traces/)
    expect(providerOption(base("postgresql", ["metrics", "records"])).description).toMatch(/^PostgreSQL · metrics, records/)
    expect(providerOption(base("shorted", ["metrics", "records"])).description).toMatch(/^Shorted · metrics, records/)
    expect(providerOption(base("uptime", ["metrics", "records"])).description).toMatch(/^Uptime · metrics, records/)
    expect(providerOption(base("mock", ["metrics", "traces"])).description).toMatch(/^Synthetic · metrics, traces/)
  })

  it("falls back to the raw type string for a type without a label, never undefined", () => {
    expect(providerTypeLabel("future-type")).toBe("future-type")
    expect(providerOption({ ...base("prometheus"), type: "future-type" as Provider["type"] }).description).toMatch(/^future-type ·/)
    expect(providerOption({ ...base("prometheus"), type: "future-type" as Provider["type"] }).description).not.toContain("undefined")
  })

  it("adds a fixed state phrase and a marker for a non-OK state, and keeps the option selectable", () => {
    const option = providerOption({ ...base("prometheus"), source: "observability", state: "NotConfigured" })
    expect(option.description).not.toContain("Last check")
    expect(option.disabled).toBeFalsy()
    const { container } = render(<>{option.details}</>)
    expect(container.querySelector("[data-provider-state='NotConfigured']")).toHaveTextContent("Last check: not configured")
    expect(container.querySelector("[data-provider-state='NotConfigured']")).toHaveAttribute("data-tone", "warning")
  })

  it("marks a failed check as danger, access and availability gaps as warning, and an OK check with no tone", () => {
    const tone = (state: "OK" | "NotConfigured" | "NotAvailable" | "Error" | "Forbidden") =>
      render(<ProviderStateMarker state={state} />).container.querySelector("[data-provider-state]")?.getAttribute("data-tone")
    expect(tone("Error")).toBe("danger")
    expect(tone("Forbidden")).toBe("warning")
    expect(tone("NotAvailable")).toBe("warning")
    expect(tone("OK")).toBeNull()
  })

  it("separates the state phrase from the type and capabilities in the accessible description", () => {
    const option = providerOption({ ...base("prometheus"), source: "observability", state: "Error" });
    const { container } = render(<span><small>{option.description}</small>{option.details}</span>);
    expect(container.textContent).toBe("Prometheus · metrics · Last check: failed");
  });

  it("renders the state details as one element, so the option's details grid gets one row", () => {
    const option = providerOption({ ...base("prometheus"), source: "observability", state: "Error" });
    const { container } = render(<span data-details="">{option.details}</span>);
    const root = container.querySelector("[data-details]")!;
    expect(root.childNodes).toHaveLength(1);
    expect(root.firstElementChild?.textContent).toBe(" · Last check: failed");
  });

  it("leaves an OK or unknown state out of the option text", () => {
    expect(providerOption({ ...base("tempo", ["traces"]), state: "OK" }).description).not.toContain("Last check")
    expect(providerOption({ ...base("tempo", ["traces"]) }).details).toBeUndefined()
  })
})
