"use client"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusGlyph } from "@/components/ui/status-chip"
import type { Condition } from "@/gen/paprika/v1/api_pb"
import { STATUS_TONES } from "@/lib/status-tone"

import { EmptyNote } from "./rollout-chrome"
import { buildRolloutLog, formatClock } from "./rollout-model"

/**
 * `Rollout.conditions[]` is already a timestamped event list, so the log is
 * that list rendered newest first — no synthesis, no interpolation, and no
 * entry the controller did not write.
 */
export function RolloutLog({
  conditions,
}: {
  conditions: readonly Condition[]
}) {
  const entries = buildRolloutLog(conditions)

  return (
    <Blueprint>
      <BoardHeader title="Rollout log" />
      {entries.length === 0 ? (
        <EmptyNote>
          The controller has recorded no conditions for this rollout yet.
        </EmptyNote>
      ) : (
        <ol>
          {entries.map((entry) => {
            const clock = formatClock(entry.iso)
            return (
              <li
                key={entry.key}
                className="flex items-baseline gap-2.25 border-b border-rule-faint px-3.5 py-[7px]"
              >
                {clock ? (
                  <time
                    dateTime={entry.iso}
                    className="w-14.5 flex-none font-mono text-meta text-neutral-600"
                  >
                    {clock}
                  </time>
                ) : (
                  <span className="w-14.5 flex-none font-mono text-meta text-neutral-600">
                    <span className="sr-only">Time not recorded</span>
                  </span>
                )}
                <StatusGlyph
                  tone={entry.tone}
                  label={`${entry.type}: ${STATUS_TONES[entry.tone].label}`}
                  className="self-center"
                />
                <span className="min-w-0 flex-1 text-note leading-normal text-neutral-800">
                  <span className="font-mono text-meta tracking-[0.06em] text-neutral-600">
                    {entry.type}
                  </span>{" "}
                  {entry.text}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </Blueprint>
  )
}
