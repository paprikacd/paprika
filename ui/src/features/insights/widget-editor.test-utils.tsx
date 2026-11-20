import type { ComponentProps } from "react";
import { vi, type Mock } from "vitest";
import type { WidgetEditor } from "./widget-editor";
import type { Provider, Widget } from "./schema";

type EditorProps = ComponentProps<typeof WidgetEditor>;

/** The editor props with its callbacks typed as spies, so tests can inspect calls. */
export type EditorTestProps = Omit<
  EditorProps,
  "onApply" | "onClose" | "onDuplicate" | "onDelete"
> & {
  onApply: Mock<EditorProps["onApply"]>;
  onClose: Mock<() => void>;
  onDuplicate: Mock<() => void>;
  onDelete: Mock<() => void>;
};

export const widget: Widget = {
  id: "requests",
  title: "Requests",
  type: "timeseries",
  query: "up",
  providerId: "production",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

export const providers: Provider[] = [
  {
    id: "staging",
    name: "Staging Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "production",
    name: "Production Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  { id: "tempo", name: "Tempo", type: "tempo", capabilities: ["traces"] },
];

/**
 * Props for the workbench shell, the only editor shape the host renders.
 * The workspace lists the widget under test, so Layout tab moves resolve
 * against the same widget the editor was given. Overrides replace any field.
 */
export function editorProps(
  overrides: Partial<EditorProps> = {},
): EditorTestProps {
  const subject = overrides.widget ?? widget;
  return {
    widget: subject,
    providers,
    onApply: vi.fn(),
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    workspace: {
      preview: null,
      dashboardTitle: "Operations",
      onDiscard: vi.fn(),
      widgets: [subject],
    },
    ...overrides,
  } as EditorTestProps;
}
