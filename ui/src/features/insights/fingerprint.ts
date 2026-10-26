import type { Dashboard } from "./schema"

/** JSON object key order is not a dashboard edit; widget array order is. */
export function documentFingerprint(document: Dashboard): string {
  return JSON.stringify(document, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  })
}
