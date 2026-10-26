/** JSON object key order is not a document edit; array order is. */
export function documentFingerprint(document: unknown): string {
  return JSON.stringify(document, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  })
}
