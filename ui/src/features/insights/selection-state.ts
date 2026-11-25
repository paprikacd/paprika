import { createContext, useContext } from "react";
import type { Dashboard, DrilldownBinding } from "./schema";
import { resolveDrilldown, type DrilldownContext, type VariableValues } from "./drilldown";
import { sameVariableValue } from "./variable-values";

/** Whether a mark's context is the selection the dashboard already shows. */
export type AppliedFilter = (context: DrilldownContext) => boolean;

/** The dashboard and the variable values its canvas shows, which a selection is compared against. */
export interface SelectionScope {
  /** Only the id and variables decide a selection, so a layout edit keeps the scope, and every tile's props, the same. */
  dashboard: Pick<Dashboard, "id" | "variables">;
  variables: VariableValues;
}

const notApplied: AppliedFilter = () => false;
const AppliedFilterContext = createContext<AppliedFilter>(notApplied);

/** Provided per tile. Outside a canvas, and for a widget without selection bindings, nothing is applied. */
export const AppliedFilterProvider = AppliedFilterContext.Provider;

export function useAppliedFilter(): AppliedFilter {
  return useContext(AppliedFilterContext);
}

/**
 * Whether the selection a context would make is already the dashboard's variable values. It resolves the bindings the
 * same way a selection does, so a context that cannot be applied (a missing label) is never applied.
 */
export function selectionApplied(
  scope: SelectionScope,
  bindings: readonly DrilldownBinding[],
  context: DrilldownContext,
): boolean {
  try {
    const selected = resolveDrilldown(
      { id: "selection", title: "Selection", dashboardId: scope.dashboard.id, carryTimeRange: false, bindings: [...bindings] },
      context,
      // resolveDrilldown reads only the target's id and variables.
      scope.dashboard as Dashboard,
    ).variables ?? {};
    // A multi-value variable's selection is a one-item list, so applied means the current list is exactly that list.
    return bindings.every(({ variable }) => {
      const current = scope.variables[variable];
      return selected[variable] !== undefined && current !== undefined && sameVariableValue(current, selected[variable]);
    });
  } catch {
    return false;
  }
}

/** The applied-filter check for one widget's selection bindings. */
export function appliedFilterFor(
  scope: SelectionScope | undefined,
  bindings: readonly DrilldownBinding[] | undefined,
): AppliedFilter {
  if (!scope || !bindings?.length) return notApplied;
  return (context) => selectionApplied(scope, bindings, context);
}
