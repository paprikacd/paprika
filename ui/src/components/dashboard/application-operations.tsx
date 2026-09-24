import { Blueprint, BoardHeader } from "@/components/ui/blueprint"

export function OperationalMetadata({ metadata }: { metadata: Record<string, string> }) {
  const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))
  if (!entries.length) return null
  return <Blueprint><BoardHeader title="Operational details" /><dl className="divide-y divide-rule-soft">
    {entries.map(([key, value]) => <div key={key} className="px-3.5 py-2"><dt className="text-meta text-muted-foreground">{key}</dt><dd className="mt-1 break-all font-mono text-note">{value}</dd></div>)}
  </dl></Blueprint>
}

export function safeOperationalLink(raw: string): boolean {
  try {
    const url = new URL(raw)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}
