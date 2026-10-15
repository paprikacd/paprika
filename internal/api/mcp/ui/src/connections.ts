// Only public connection preferences belong in browser storage. Authentication
// stays with the host's named MCP connection and native OAuth flow.
export interface Instance {
  label: string;
  connection: string;
  endpoint: string;
  example?: boolean;
}
export interface ConnectionIdentity {
  endpoint: string;
  origin: string;
  name: string;
  account: { name?: string; email?: string };
  scopes: string[];
  server: { version?: string; commit?: string; date?: string };
}
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const storageKey = "paprika.console.instances.v1";
export const exampleInstances: Instance[] = [
  { label: "Personal", connection: "paprika_hosted", endpoint: "https://paprika.benebsworth.com/mcp", example: true },
  { label: "StarfleetHub", connection: "paprika_starfleethub", endpoint: "https://paprika.starfleethub.com/mcp", example: true },
];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const cleanText = (value: unknown, limit: number): string => text(value).trim().slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, "");

export function endpoint(value: unknown, allowLoopback = false): string | undefined {
  try {
    const raw = text(value).trim();
    if (raw.length > 512 || /[\s\\]/.test(raw)) return;
    const url = new URL(raw);
    const local = allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) return;
    const dns = url.hostname.length <= 253 && url.hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
    const ipv6 = /^\[[a-f0-9:]+\]$/i.test(url.hostname);
    if (!dns && !ipv6) return;
    if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/mcp")) return;
    if (!/^\/[a-zA-Z0-9._~/-]*$/.test(url.pathname) || /\/\//.test(url.pathname) || raw.includes("/../") || raw.includes("/./")) return;
    return `${url.origin}${url.pathname}`;
  } catch { return; }
}

export function parseInstance(value: unknown): Instance | undefined {
  const item = record(value);
  const label = cleanText(item.label, 64);
  const connection = text(item.connection).trim();
  const url = endpoint(item.endpoint);
  if (!label || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(connection) || !url) return;
  return { label, connection, endpoint: url };
}

export function parseConnection(value: unknown): ConnectionIdentity | undefined {
  const data = record(value);
  const url = endpoint(data.endpoint, true);
  if (!url) return;
  const origin = new URL(url).origin;
  // Cross-check the canonical public URL; do not silently choose a hostname
  // from a disagreeing identity or a saved preference.
  if (text(data.origin).replace(/\/$/, "") !== origin) return;
  const account = record(data.account), server = record(data.server);
  return {
    endpoint: url, origin, name: cleanText(data.name, 100) || new URL(url).host,
    account: { ...(account.name ? { name: cleanText(account.name, 100) } : {}), ...(account.email ? { email: cleanText(account.email, 200) } : {}) },
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((value): value is string => typeof value === "string" && /^[a-zA-Z0-9:._-]{1,100}$/.test(value)).slice(0, 20) : [],
    server: Object.fromEntries(["version", "commit", "date"].filter((key) => server[key]).map((key) => [key, cleanText(server[key], 100)])),
  };
}

export function readInstances(storage?: PreferenceStorage): { instances: Instance[]; unavailable: boolean } {
  try {
    const raw = storage?.getItem(storageKey);
    const data = raw ? record(JSON.parse(raw)) : {};
    const saved = data.version === 1 && Array.isArray(data.instances) ? data.instances.slice(0, 20).map(parseInstance).filter((item): item is Instance => Boolean(item)) : [];
    const instances = [...exampleInstances.map((item) => ({ ...item })), ...saved];
    return { instances: [...new Map(instances.map((item) => [item.connection, item])).values()], unavailable: !storage };
  } catch { return { instances: exampleInstances.map((item) => ({ ...item })), unavailable: true }; }
}

export function writeInstances(storage: PreferenceStorage | undefined, instances: Instance[]): boolean {
  if (!storage) return false;
  try {
    // Re-parse to strip arbitrary extra fields, including possible credentials.
    const saved = instances.filter((item) => !item.example).map(parseInstance).filter(Boolean).slice(0, 20);
    storage.setItem(storageKey, JSON.stringify({ version: 1, instances: saved }));
    return true;
  } catch { return false; }
}

export function switchPrompt(instance: Instance): string {
  return `Open Paprika instance ${JSON.stringify(instance.label)} using the named MCP connection ${instance.connection} at ${instance.endpoint}. First call get_connection on that connection and verify its endpoint is exactly ${instance.endpoint}, then call open_fleet on the same connection to open its console. Do not use another connection or fall back to the current deployment. If the named connection is unavailable or unauthenticated, help me add it with this exact endpoint and authenticate through Codex's native OAuth with paprika:read, then verify get_connection before opening the fleet. Do not copy credentials between instances or make deployment changes.`;
}

export function setupCommands(instance: Instance): string {
  return `codex mcp add ${instance.connection} --url '${instance.endpoint}'\ncodex mcp login ${instance.connection} --scopes paprika:read`;
}
