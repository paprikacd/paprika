import { describe, expect, it } from "vitest";
import { AGENT_LINK_MAX, buildAgentHandoff } from "./agent-handoff";

describe("buildAgentHandoff", () => {
  it("names the dashboard, the endpoint and the request, and asks for widget_edits only", () => {
    const handoff = buildAgentHandoff({ id: "svc", title: "Service", request: "Show p95 latency", endpoint: "https://example.test/observe/mcp" });
    const lines = handoff.text.split("\n");
    expect(lines[0]).toBe('Edit the Paprika Insights dashboard "Service" (id: svc).');
    expect(lines[1]).toBe("Use the Paprika Observe MCP server at https://example.test/observe/mcp.");
    expect(lines[2]).toBe("Request: Show p95 latency");
    expect(handoff.text).toContain('get_dashboard with id "svc"');
    expect(handoff.text).toContain('{"id":"svc","widget_edits":[…]}');
    expect(handoff.text).toContain("Do not call patch_dashboard or update_dashboard.");
    expect(handoff.text).not.toContain("The open draft");
  });

  it("uses a default request and no endpoint when Observe is not connected", () => {
    const handoff = buildAgentHandoff({ id: "svc", title: "Service" });
    expect(handoff.text).toContain("Use your Paprika Observe MCP server.");
    expect(handoff.text).toContain("Request: Improve the layout while keeping existing queries and providers.");
    expect(handoff.setupCommand).toBeUndefined();
  });

  it("adds the setup command and a prefilled link when the endpoint is known", () => {
    const handoff = buildAgentHandoff({ id: "svc", title: "Service", endpoint: "https://example.test/observe/mcp" });
    expect(handoff.setupCommand).toBe("claude mcp add --transport http paprika-observe https://example.test/observe/mcp");
    expect(handoff.links).toEqual([{ label: "Open in Claude", href: `https://claude.ai/new?q=${encodeURIComponent(handoff.text)}` }]);
  });

  it("hands over the unsaved draft instead of the saved dashboard", () => {
    const draft = { id: "svc", title: "Draft title" };
    const handoff = buildAgentHandoff({ id: "svc", title: "Service", draft });
    expect(handoff.text).toContain("The open draft has unsaved changes. Edit this draft, not the saved dashboard:");
    expect(handoff.text.endsWith(JSON.stringify(draft))).toBe(true);
  });

  it("omits the link when the prefilled address is longer than the limit", () => {
    const handoff = buildAgentHandoff({ id: "svc", title: "Service", request: "x".repeat(AGENT_LINK_MAX) });
    expect(handoff.links).toEqual([]);
    expect(handoff.text.length).toBeGreaterThan(AGENT_LINK_MAX);
  });
});
