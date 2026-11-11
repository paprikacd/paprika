import { z } from "zod";
import { SERIES_ROLES, seriesRole } from "./series-palette";

const seriesRule = z.strictObject({
  label: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100),
  value: z.string().min(1).max(256),
  /** A six-digit hex colour, or a semantic role from series-palette.ts. Exactly one is required. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color").optional(),
  role: z.enum(SERIES_ROLES).optional(),
}).superRefine((rule, context) => {
  if (rule.color === undefined && rule.role === undefined) context.addIssue({ code: "custom", message: "Name a hex color or a series role" });
  else if (rule.color !== undefined && rule.role !== undefined) context.addIssue({ code: "custom", message: "Use a hex color or a series role, not both" });
});

/** Exact metric labels, not array positions, identify a semantic series. */
export const seriesColorRulesSchema = z.array(seriesRule).max(24).superRefine((rules, context) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const key = JSON.stringify([rule.label, rule.value]);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "Each label and value may only have one color" });
    seen.add(key);
  });
});

export type SeriesColorRule = z.infer<typeof seriesColorRulesSchema>[number];
/** The first rule whose exact label and value match sets the colour; a rule names a hex colour or a role. */
export function resolveSeriesColor(labels: Readonly<Record<string, string>>, rules: readonly SeriesColorRule[] | undefined, fallback: string): string {
  const rule = rules?.find(entry => labels[entry.label] === entry.value);
  if (!rule) return fallback;
  return rule.color ?? (rule.role ? seriesRole(rule.role) : fallback);
}
