import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import type { SavedQuery } from "./schema";
import { editorProps, providers, widget } from "./widget-editor.test-utils";

const saved: SavedQuery = { schemaVersion: 1, id: "requests", name: "Requests", providerId: "production", kind: "metrics", query: "up" };

describe("Edit in Explore for a linked saved query", () => {
  it("opens Explore from the linked query, and offers nothing without an explorer", () => {
    const onOpenExplorer = vi.fn();
    const linked = { ...widget, queryRef: { id: "requests" } };
    const { unmount } = render(
      <SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}} onOpenExplorer={onOpenExplorer}>
        <WidgetEditor {...editorProps({ widget: linked })} providers={providers} widget={linked} />
      </SavedQueryLibraryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit in Explore" }));
    expect(onOpenExplorer).toHaveBeenCalledOnce();
    // The click event is not a trace seed: a seeded open would remount Explore on an empty query and an invalid range.
    expect(onOpenExplorer).toHaveBeenCalledWith();
    unmount();

    render(
      <SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}}>
        <WidgetEditor {...editorProps({ widget: linked })} providers={providers} widget={linked} />
      </SavedQueryLibraryProvider>,
    );
    expect(screen.queryByRole("button", { name: "Edit in Explore" })).toBeNull();
  });
});
