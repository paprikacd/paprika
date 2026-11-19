// The slo-summary widget's authored config, as a Zod schema. It mirrors validateSloConfig in slo.ts, and the
// schema test checks that the two accept the same conformance cases. The Go validator is the server's copy.
import { z } from "zod";

import {
  isSloGroupLabel,
  isSloObjective,
  isSloSelector,
  SLO_PERIODS,
  sloMaxRowsLimit,
  type SloConfig,
} from "./slo";

const selector = z.string().refine(isSloSelector, { message: "Use a metric name with optional label matchers." });

export const sloSummaryConfigSchema = z
  .strictObject({
    objective: z
      .number()
      .refine(isSloObjective, { message: "Use a percent from 50 to 99.9999 with at most four decimal places." }),
    period: z.enum(SLO_PERIODS),
    total: selector,
    bad: selector.optional(),
    good: selector.optional(),
    burnAlerts: z.enum(["multiwindow", "page", "none"]).optional(),
    groupBy: z
      .string()
      .refine(isSloGroupLabel, { message: "Use a label name that is not an SLO label." })
      .optional(),
    maxRows: z.number().int().min(1).max(12).optional(),
  })
  .superRefine((config, context) => {
    if ((config.bad === undefined) === (config.good === undefined))
      context.addIssue({ code: "custom", message: "Set exactly one of bad or good." });
    if (config.maxRows !== undefined && config.maxRows > sloMaxRowsLimit(config as SloConfig))
      context.addIssue({ code: "custom", path: ["maxRows"], message: "This preset lists fewer groups within the provider's series limit." });
  });

/** Parses an authored objective. Throws a Zod error when the config is not valid. */
export function parseSloConfig(config: unknown): SloConfig {
  return sloSummaryConfigSchema.parse(config) as SloConfig;
}
