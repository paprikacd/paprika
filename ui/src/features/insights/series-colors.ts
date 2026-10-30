import { z } from "zod";

/** Exact metric labels, not array positions, identify a semantic series. */
export const seriesColorRulesSchema = z.array(z.strictObject({
  label: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100),
  value: z.string().min(1).max(256),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color"),
})).max(24).superRefine((rules, context) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const key = JSON.stringify([rule.label, rule.value]);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "Each label and value may only have one color" });
    seen.add(key);
  });
});

export type SeriesColorRule = z.infer<typeof seriesColorRulesSchema>[number];
export function resolveSeriesColor(labels: Readonly<Record<string, string>>, rules: readonly SeriesColorRule[] | undefined, fallback: string): string {
  return rules?.find(rule => labels[rule.label] === rule.value)?.color ?? fallback;
}
