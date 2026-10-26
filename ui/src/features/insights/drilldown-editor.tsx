"use client";

import { Link2, Plus, Trash2 } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { GammaInput } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { GammaSwitch } from "./gamma/switch";
import {
  MAX_DASHBOARD_VARIABLES,
  MAX_VARIABLE_VALUE_LENGTH,
  type Dashboard,
  type Drilldown,
  type DrilldownBinding,
  type Widget,
} from "./schema";
import styles from "./drilldown.module.css";

const sources = [
  {
    value: "label",
    label: "Label",
    description: "A label from the selected series",
  },
  { value: "value", label: "Value", description: "The selected numeric value" },
  {
    value: "series",
    label: "Series name",
    description: "The selected series name",
  },
  {
    value: "constant",
    label: "Constant",
    description: "A value you define here",
  },
] as const;

export interface DrilldownEditorProps {
  widget: Widget;
  dashboards: Dashboard[];
  onChange: (widget: Widget) => void;
}

export function DrilldownEditor({
  widget,
  dashboards,
  onChange,
}: DrilldownEditorProps) {
  const links = widget.drilldowns ?? [];
  function update(next: Drilldown[]) {
    const copy = { ...widget };
    if (next.length) copy.drilldowns = next;
    else delete copy.drilldowns;
    onChange(copy);
  }
  function patch(index: number, value: Partial<Drilldown>) {
    update(
      links.map((link, current) =>
        current === index ? { ...link, ...value } : link,
      ),
    );
  }
  function bindings(index: number, next: DrilldownBinding[]) {
    patch(index, { bindings: next });
  }
  return (
    <section className={styles.editor} aria-label="Dashboard links">
      <p className={styles.help}>
        Connect this widget to another dashboard. Choose a series, table row or
        heatmap cell to pass its context. Links using constants can also open
        from the widget menu.
      </p>
      {!links.length && (
        <div className={styles.empty}>
          <Link2 size={18} aria-hidden="true" />
          <strong>Follow a signal further</strong>
          <span>
            Open a service dashboard with the same time range and relevant
            variables.
          </span>
        </div>
      )}
      {links.map((link, index) => {
        const target = dashboards.find(
          (dashboard) => dashboard.id === link.dashboardId,
        );
        const variables = target?.variables ?? [];
        const assigned = link.bindings ?? [];
        const available = variables.filter(
          (variable) =>
            !assigned.some((binding) => binding.variable === variable.name),
        );
        const targetOptions = dashboards.map((dashboard) => ({
          value: dashboard.id,
          label: dashboard.title,
          description: dashboard.folder || dashboard.id,
          keywords: [dashboard.id, dashboard.folder ?? ""],
        }));
        if (!target)
          targetOptions.unshift({
            value: link.dashboardId,
            label: `Unavailable: ${link.dashboardId}`,
            description: "Choose an available dashboard",
            keywords: [],
          });
        return (
          <fieldset className={styles.card} key={link.id}>
            <legend>Link {index + 1}</legend>
            <div className={styles.cardHeading}>
              <span className={styles.eyebrow}>Dashboard link</span>
              <GammaButton iconOnly
                variant="ghost"
                size="sm"
                aria-label={`Remove link ${index + 1}`}
                onClick={() =>
                  update(links.filter((_, current) => current !== index))
                }
              >
                <Trash2 size={14} aria-hidden="true" />
              </GammaButton>
            </div>
            <label className={styles.field}>
              <span>Link title</span>
              <GammaInput
                aria-label={`Link ${index + 1} title`}
                value={link.title}
                maxLength={120}
                onChange={(event) =>
                  patch(index, { title: event.target.value })
                }
              />
            </label>
            <div className={styles.field}>
              <span>Destination dashboard</span>
              <GammaSelect
                aria-label={`Link ${index + 1} destination`}
                value={link.dashboardId}
                options={targetOptions}
                searchable
                onValueChange={(dashboardId) => {
                  const next = dashboards.find(
                    (dashboard) => dashboard.id === dashboardId,
                  );
                  const names = new Set(
                    next?.variables?.map((variable) => variable.name),
                  );
                  patch(index, {
                    dashboardId,
                    bindings: assigned.filter((binding) =>
                      names.has(binding.variable),
                    ),
                  });
                }}
              />
            </div>
            {!target && (
              <p role="alert" className={styles.error}>
                Destination “{link.dashboardId}” is unavailable. Choose another
                dashboard before using this link.
              </p>
            )}
            <GammaSwitch
              label="Carry time range"
              description="Open the destination at the exact time shown here."
              checked={link.carryTimeRange !== false}
              onChange={(carryTimeRange) => patch(index, { carryTimeRange })}
            />
            <div className={styles.bindingHeader}>
              <strong>Pass variables</strong>
              <span>
                {assigned.length}/{variables.length}
              </span>
            </div>
            {!variables.length && target && (
              <p className={styles.help}>
                This destination has no variables. Add them in its dashboard
                settings to pass context.
              </p>
            )}
            {assigned.map((binding, bindingIndex) => {
              const known = variables.some(
                (variable) => variable.name === binding.variable,
              );
              const options = variables.map((variable) => ({
                value: variable.name,
                label: variable.label || variable.name,
                description: variable.label ? variable.name : undefined,
                disabled: assigned.some(
                  (other, otherIndex) =>
                    otherIndex !== bindingIndex &&
                    other.variable === variable.name,
                ),
              }));
              if (!known)
                options.unshift({
                  value: binding.variable,
                  label: `Unavailable: ${binding.variable}`,
                  description: "Choose a declared variable",
                  disabled: false,
                });
              const edit = (next: DrilldownBinding) =>
                bindings(
                  index,
                  assigned.map((value, current) =>
                    current === bindingIndex ? next : value,
                  ),
                );
              return (
                <fieldset className={styles.binding} key={bindingIndex}>
                  <legend>Binding {bindingIndex + 1}</legend>
                  <div className={styles.bindingTop}>
                    <div className={styles.field}>
                      <span>Target variable</span>
                      <GammaSelect
                        aria-label={`Link ${index + 1} binding ${bindingIndex + 1} variable`}
                        value={binding.variable}
                        options={options}
                        onValueChange={(variable) =>
                          edit({ ...binding, variable })
                        }
                      />
                    </div>
                    <GammaButton iconOnly
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove link ${index + 1} binding ${bindingIndex + 1}`}
                      onClick={() =>
                        bindings(
                          index,
                          assigned.filter(
                            (_, current) => current !== bindingIndex,
                          ),
                        )
                      }
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </GammaButton>
                  </div>
                  {!known && (
                    <p role="alert" className={styles.error}>
                      Variable “{binding.variable}” is not declared by this
                      destination. Choose another variable or remove the
                      binding.
                    </p>
                  )}
                  <div className={styles.field}>
                    <span>Value source</span>
                    <GammaSelect
                      aria-label={`Link ${index + 1} binding ${bindingIndex + 1} source`}
                      value={binding.source}
                      options={sources}
                      onValueChange={(value) => {
                        const source = value as DrilldownBinding["source"];
                        edit(
                          source === "label"
                            ? {
                                variable: binding.variable,
                                source,
                                value: binding.variable,
                              }
                            : source === "constant"
                              ? {
                                  variable: binding.variable,
                                  source,
                                  value: "",
                                }
                              : { variable: binding.variable, source },
                        );
                      }}
                    />
                  </div>
                  {(binding.source === "label" ||
                    binding.source === "constant") && (
                    <label className={styles.field}>
                      <span>
                        {binding.source === "label"
                          ? "Label key"
                          : "Constant value"}
                      </span>
                      <GammaInput
                        aria-label={`Link ${index + 1} binding ${bindingIndex + 1} ${binding.source === "label" ? "label key" : "constant value"}`}
                        value={binding.value ?? ""}
                        maxLength={
                          binding.source === "label"
                            ? 128
                            : MAX_VARIABLE_VALUE_LENGTH
                        }
                        placeholder={
                          binding.source === "label"
                            ? "service"
                            : "Any string, including an empty value"
                        }
                        onChange={(event) =>
                          edit({ ...binding, value: event.target.value })
                        }
                      />
                    </label>
                  )}
                  <p className={styles.help}>
                    {binding.source === "label"
                      ? "The selected series must contain this label. Missing labels are reported before navigation."
                      : binding.source === "value"
                        ? "Uses the selected observation before display rounding, or the latest value when choosing a series."
                        : binding.source === "series"
                          ? "Uses the complete name of the selected series."
                          : "Passes this exact text. Query variables are escaped as quoted string values."}
                  </p>
                </fieldset>
              );
            })}
            <GammaButton
              size="sm"
              variant="quiet"
              disabled={
                !available.length || assigned.length >= MAX_DASHBOARD_VARIABLES
              }
              aria-label={`Add variable binding to link ${index + 1}`}
              onClick={() => {
                if (available[0])
                  bindings(index, [
                    ...assigned,
                    {
                      variable: available[0].name,
                      source: "label",
                      value: available[0].name,
                    },
                  ]);
              }}
            >
              <Plus size={13} aria-hidden="true" /> Add variable binding
            </GammaButton>
            {!!variables.length && (
              <p className={styles.help}>
                Variables without a binding use the destination’s defaults.
                Changing the destination removes bindings it does not declare.
              </p>
            )}
          </fieldset>
        );
      })}
      <GammaButton
        size="sm"
        disabled={!dashboards.length || links.length >= 8}
        onClick={() => {
          const target = dashboards[0];
          if (target)
            update([
              ...links,
              {
                id: `link-${crypto.randomUUID()}`,
                title: `Open ${target.title}`.slice(0, 120),
                dashboardId: target.id,
                carryTimeRange: true,
              },
            ]);
        }}
      >
        <Plus size={14} aria-hidden="true" /> Add dashboard link
      </GammaButton>
      {!dashboards.length && (
        <p className={styles.help}>Create a dashboard before adding a link.</p>
      )}
      {links.length >= 8 && (
        <p className={styles.help}>
          A widget can have up to eight dashboard links.
        </p>
      )}
    </section>
  );
}
