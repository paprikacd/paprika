import { expect, type Locator, type Page, type Request, type Response } from "@playwright/test"

export const QUERY_FLEET_MAP_PATH = "/paprika.v1.PaprikaService/QueryFleetMap"

const APPLICATION_KIND = "FLEET_MAP_NODE_KIND_APPLICATION"
// BigInt constructors keep this independent 64-bit oracle compatible with the
// UI's pre-ES2020 TypeScript output target (BigInt literals do not compile).
const FNV_64_OFFSET = BigInt("14695981039346656037")
const FNV_64_PRIME = BigInt("1099511628211")
const UINT64_MASK = BigInt("18446744073709551615")

export interface WireObjectKey {
  namespace?: string
  name?: string
}

export interface WireApplicationMetadata {
  project?: WireObjectKey
  currentCluster?: WireObjectKey
  currentStage?: string
  sync?: string
  release?: string
  rollout?: string
}

export interface WireFleetMapNode {
  stableId?: string
  kind?: string
  application?: WireObjectKey
  applicationMetadata?: WireApplicationMetadata
  children?: WireFleetMapNode[]
}

interface WireFleetMapResponse {
  roots?: WireFleetMapNode[]
  total?: string | number
}

export interface FleetMapCapture {
  url: string
  request: Record<string, unknown>
  response: WireFleetMapResponse
  leaves: WireFleetMapNode[]
  stableIds: string[]
  total: number
  digest: string
}

export interface HeatmapOracleResult {
  capture: FleetMapCapture
  host: Locator
  inputCount: number
  layoutCount: number
  digest: string
}

/**
 * Independent wire oracle for the browser tests. It deliberately does not
 * import the UI's fleet client, layout code, or digest implementation.
 */
export class FleetMapOracle {
  readonly captures: FleetMapCapture[] = []
  readonly captureErrors: string[] = []

  private readonly page: Page
  private readonly onResponse: (response: Response) => void
  private readonly pending = new Set<Promise<void>>()

  constructor(page: Page) {
    this.page = page
    this.onResponse = (response) => {
      const capture = this.capture(response)
      this.pending.add(capture)
      void capture.finally(() => this.pending.delete(capture))
    }
    page.on("response", this.onResponse)
  }

  async drain() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  async snapshot() {
    await this.drain()
    return {
      captures: [...this.captures],
      captureErrors: [...this.captureErrors],
    }
  }

  async stop() {
    this.page.off("response", this.onResponse)
    await this.drain()
  }

  private async capture(response: Response) {
    if (new URL(response.url()).pathname !== QUERY_FLEET_MAP_PATH || !response.ok()) return

    try {
      const body = await response.json() as WireFleetMapResponse
      const request = requestJSON(response.request())
      const leaves = flattenApplicationLeaves(body.roots ?? [])
      const stableIds = leaves.map((leaf, index) => {
        if (!leaf.stableId) throw new Error(`Application leaf ${index} omitted stableId`)
        return leaf.stableId
      })
      this.captures.push({
        url: response.url(),
        request,
        response: body,
        leaves,
        stableIds,
        total: decimalCount(body.total),
        digest: independentStableIdDigest(stableIds),
      })
    } catch (error) {
      this.captureErrors.push(error instanceof Error ? error.message : String(error))
    }
  }
}

export function observeFleetMapResponses(page: Page) {
  return new FleetMapOracle(page)
}

export async function expectCompleteHeatmap(
  page: Page,
  oracle: FleetMapOracle,
  expectedCount?: number,
): Promise<HeatmapOracleResult> {
  const host = page.getByRole("application", { name: "Fleet health heatmap" })
  await expect(host).toBeVisible()

  await expect.poll(
    async () => {
      const attributes = await heatmapAttributes(host)
      const capture = oracle.captures.find(
        (candidate) =>
          candidate.digest === attributes.digest &&
          candidate.stableIds.length === attributes.inputCount,
      )
      return capture ? { attributes, capture } : null
    },
    { message: "rendered heatmap must match one successful QueryFleetMap response" },
  ).not.toBeNull()

  // Playwright's matcher does not return the polled value, so read the stable
  // host contract once more and select the same capture deterministically.
  const attributes = await heatmapAttributes(host)
  const snapshot = await oracle.snapshot()
  const capture = snapshot.captures.find(
    (candidate) =>
      candidate.digest === attributes.digest &&
      candidate.stableIds.length === attributes.inputCount,
  )
  expect(capture, "a successful QueryFleetMap response must own the rendered host digest").toBeDefined()
  expect(snapshot.captureErrors, "every successful QueryFleetMap response must be parseable").toEqual([])

  for (const candidate of snapshot.captures) assertWireCompleteness(candidate)
  expect(attributes.inputCount, "host input count must equal intercepted raw Application leaves")
    .toBe(capture!.stableIds.length)
  expect(attributes.layoutCount, "host layout count must equal intercepted raw Application leaves")
    .toBe(capture!.stableIds.length)
  expect(attributes.digest, "host digest must equal the independently computed sorted-ID digest")
    .toBe(capture!.digest)
  if (expectedCount !== undefined) {
    expect(capture!.total, "fixture response total").toBe(expectedCount)
  }

  return {
    capture: capture!,
    host,
    inputCount: attributes.inputCount,
    layoutCount: attributes.layoutCount,
    digest: attributes.digest,
  }
}

export function assertWireCompleteness(capture: FleetMapCapture) {
  const uniqueStableIds = new Set(capture.stableIds)
  expect(capture.total, "response.total must equal the raw recursive Application-leaf count")
    .toBe(capture.leaves.length)
  expect(capture.leaves.length, "raw Application-leaf count must equal unique stable-ID count")
    .toBe(uniqueStableIds.size)
}

export function flattenApplicationLeaves(roots: readonly WireFleetMapNode[]) {
  const leaves: WireFleetMapNode[] = []
  const pending = [...roots]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    if (node.kind === APPLICATION_KIND) leaves.push(node)
    pending.push(...(node.children ?? []))
  }
  return leaves
}

export function independentStableIdDigest(stableIds: readonly string[]) {
  const encoder = new TextEncoder()
  let hash = FNV_64_OFFSET
  const hashByte = (byte: number) => {
    hash ^= BigInt(byte)
    hash = (hash * FNV_64_PRIME) & UINT64_MASK
  }

  const ordered = [...stableIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  for (const stableId of ordered) {
    const encoded = encoder.encode(stableId)
    hashByte((encoded.length >>> 24) & 0xff)
    hashByte((encoded.length >>> 16) & 0xff)
    hashByte((encoded.length >>> 8) & 0xff)
    hashByte(encoded.length & 0xff)
    for (const byte of encoded) hashByte(byte)
  }
  return `hm1-${hash.toString(16).padStart(16, "0")}`
}

function decimalCount(value: string | number | undefined) {
  if (value === undefined) return 0
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid QueryFleetMap count ${JSON.stringify(value)}`)
  }
  return parsed
}

function requestJSON(request: Request): Record<string, unknown> {
  try {
    const value = request.postDataJSON()
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function heatmapAttributes(host: Locator) {
  return host.evaluate((element) => {
    const inputCount = Number(element.getAttribute("data-heatmap-input-count"))
    const layoutCount = Number(element.getAttribute("data-heatmap-layout-count"))
    const digest = element.getAttribute("data-heatmap-layout-digest") ?? ""
    if (!Number.isSafeInteger(inputCount) || inputCount < 0) {
      throw new Error("heatmap host omitted a valid input count")
    }
    if (!Number.isSafeInteger(layoutCount) || layoutCount < 0) {
      throw new Error("heatmap host omitted a valid layout count")
    }
    if (!/^hm1-[0-9a-f]{16}$/u.test(digest)) {
      throw new Error(`heatmap host exposed invalid digest ${JSON.stringify(digest)}`)
    }
    return { inputCount, layoutCount, digest }
  })
}
