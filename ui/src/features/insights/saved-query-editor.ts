import type { Provider, TooltipView } from "./schema";
import type { SavedQueryLibrary } from "./saved-query-context";
import { resolveSavedQueryReference } from "./saved-queries";

/** Check authoring with representative observation values; real values resolve only on hover. */
export function validateLinkedTooltip(
  view: TooltipView,
  library: SavedQueryLibrary,
  providers: Provider[],
) {
  if (view.source?.type !== "saved") return;
  if (library.loading) throw new Error("The saved query library is loading.");
  if (library.error) throw new Error(library.error);
  const kind =
    view.type === "traces" || view.dataKind === "traces" ? "traces" : "metrics";
  const labels: Record<string, string> = Object.create(null);
  for (const binding of view.source.ref.bindings ?? []) {
    if (binding.source === "label") labels[binding.label] = "1";
  }
  const resolved = resolveSavedQueryReference(
    view.source.ref,
    library.queries,
    library.values,
    kind,
    {
      series: { name: "validation", labels, points: [] },
      point: { value: 1, timestamp: 1000 },
    },
  );
  if (
    !providers.some(
      (provider) =>
        provider.id === resolved.providerId &&
        provider.capabilities.includes(kind),
    )
  )
    throw new Error(
      "Choose a saved tooltip query with an available compatible provider.",
    );
}
