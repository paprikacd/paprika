import { z } from "zod"
import type { RecordFrame } from "./schema"

const scalar = z.union([
  z.string().max(16 * 1024),
  z
    .number()
    .finite()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.null(),
])
const frameSchema = z
  .strictObject({
    columns: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(128),
          label: z.string().max(256).optional(),
          type: z.enum(["string", "number", "boolean", "timestamp"]),
          unit: z.string().max(24).optional(),
        }),
      )
      .min(1)
      .max(64),
    rows: z.array(z.array(scalar).max(64)).max(1000),
    truncated: z.boolean().optional(),
  })
  .superRefine((frame, context) => {
    const keys = new Set<string>()
    for (const [index, column] of frame.columns.entries()) {
      if (
        keys.has(column.key) ||
        ["__proto__", "prototype", "constructor"].includes(column.key)
      )
        context.addIssue({
          code: "custom",
          path: ["columns", index, "key"],
          message: "Record columns must have unique, non-reserved keys",
        })
      keys.add(column.key)
    }
    frame.rows.forEach((row, index) => {
      if (row.length !== frame.columns.length)
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "Record row does not match its columns",
        })
      row.forEach((value, cell) => {
        const type = frame.columns[cell]?.type
        if (value === null) return
        if (
          type === "timestamp"
            ? typeof value !== "string" ||
              !z.iso.datetime({ offset: true }).safeParse(value).success
            : typeof value !== type
        )
          context.addIssue({
            code: "custom",
            path: ["rows", index, cell],
            message: "Record value does not match its column type",
          })
      })
    })
  })

/** API and sample sources share one bounded frame contract; opaque objects are never cells. */
export function parseRecordFrame(input: unknown): RecordFrame {
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength >
    4 * 1024 * 1024
  )
    throw new Error("Record response exceeds 4 MiB")
  return frameSchema.parse(input)
}
