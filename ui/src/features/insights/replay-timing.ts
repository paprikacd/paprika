// Replay timing shared by the client and the query scheduler. It lives apart
// from client.ts so the scheduler does not import the generated protobuf
// modules: the widget lab type-checks query.ts without them.

// No replay waits longer than this, however large the server's Retry-After is.
export const REPLAY_DELAY_CAP_MS = 10_000

/** Spreads a replay delay by +-30%, so viewers blocked by one busy spell do not replay in step. */
export function jitter(delay: number): number {
  return Math.round(delay * (0.7 + 0.6 * Math.random()))
}
