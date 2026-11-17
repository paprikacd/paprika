import type { Provider } from "./schema"

const placeholder = /^\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/
const anyPlaceholder = /\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/

/** Top-level raw fragments preserve unresolved parameters and never execute code. */
export function jsonObjectFragments(source: string): Map<string, string> {
  const fields = new Map<string, string>()
  let index = source.indexOf("{") + 1
  while (index < source.length) {
    while (/\s|,/.test(source[index] ?? "") && index < source.length) index++
    if (source[index] === "}") return fields
    const keyStart = index++
    while (index < source.length && source[index] !== '"') { if (source[index] === "\\") index++; index++ }
    const key: string = JSON.parse(source.slice(keyStart, ++index))
    while (/\s/.test(source[index] ?? "") && index < source.length) index++
    if (source[index++] !== ":" || fields.has(key)) throw new Error("Invalid SQL envelope")
    const start = index
    let depth = 0, quoted = false
    for (; index < source.length; index++) {
      const char = source[index]
      if (quoted) {
        if (char === "\\") index++
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === "[" || char === "{") depth++
      else if ((char === "," || char === "}") && depth === 0) break
      else if (char === "]" || char === "}") depth--
    }
    fields.set(key, source.slice(start, index).trim())
  }
  throw new Error("Invalid SQL envelope")
}

/** Check the authored template BEFORE any dashboard/hover value interpolation. */
export function assertProviderQueryTemplate(providerType: Provider["type"] | undefined, query: string): void {
  if (providerType !== "postgresql" || !anyPlaceholder.test(query)) return
  const fail = () => new Error("SQL placeholders belong only in the envelope parameters array. Use $1, $2 in a fixed SQL body.")
  if (!query.trimStart().startsWith("{")) throw fail()
  let shadow = "", quoted = false
  for (let index = 0; index < query.length;) {
    const token = query.slice(index).match(placeholder)?.[0]
    if (token) {
      if (quoted) throw fail()
      shadow += "null"
      index += token.length
      continue
    }
    const char = query[index++]
    shadow += char
    if (quoted && char === "\\") { shadow += query[index++] ?? ""; continue }
    if (char === '"') quoted = !quoted
  }
  try {
    const parsed = JSON.parse(shadow)
    if (!parsed || typeof parsed.sql !== "string" || anyPlaceholder.test(parsed.sql) || !Array.isArray(parsed.parameters)) throw fail()
    for (const [key, value] of jsonObjectFragments(query)) if (key !== "parameters" && anyPlaceholder.test(value)) throw fail()
  } catch { throw fail() }
}
