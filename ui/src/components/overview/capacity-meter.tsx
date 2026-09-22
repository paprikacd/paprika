"use client"

import {
  ResourceUnit,
  type ResourceMeter,
} from "@/gen/paprika/v1/api_pb"
import { cn } from "@/lib/utils"

import { UnavailableNote } from "./data-notice"
import { numbersAreReal } from "./data-state"

/** Requests above this share of allocatable are flagged. */
export const HOT_REQUEST_RATIO = 0.85

export function unitName(unit: ResourceUnit): string {
  return unit === ResourceUnit.BYTES ? "GiB" : "cores"
}

export function inUnit(value: number, unit: ResourceUnit): number {
  return unit === ResourceUnit.BYTES ? value / 2 ** 30 : value / 1000
}

function formatValue(value: number, unit: ResourceUnit): string {
  const converted = inUnit(value, unit)
  return unit === ResourceUnit.BYTES
    ? Math.round(converted).toString()
    : converted.toFixed(1)
}

/**
 * One capacity meter, drawn from whichever of its three components this server
 * can actually answer.
 *
 * `ResourceMeter` carries a state per component precisely because requested and
 * allocatable come from the Kubernetes API while `used` needs a metrics
 * provider. A cluster with no metrics-server still gets a real requested marker
 * against a real allocatable track; only the used fill goes away, and it says
 * why rather than drawing zero.
 */
export function CapacityMeter({
  label,
  meter,
}: {
  label: string
  meter: ResourceMeter
}) {
  const allocatableReal = numbersAreReal(meter.allocatableState)
  const requestedReal = numbersAreReal(meter.requestedState)
  const usedReal = numbersAreReal(meter.usedState)

  if (!allocatableReal) {
    return (
      <div>
        <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
          {label}
        </span>
        <UnavailableNote
          className="mt-1"
          reason={
            meter.unavailableReason ||
            "Allocatable capacity is not available from this server."
          }
        />
      </div>
    )
  }

  const unit = meter.unit
  const allocatable = meter.allocatable
  const usedPercent = usedReal
    ? Math.min(100, (meter.used / allocatable) * 100)
    : 0
  const requestedRatio = requestedReal ? meter.requested / allocatable : 0
  const hot = requestedReal && requestedRatio > HOT_REQUEST_RATIO

  const readout = [
    usedReal ? formatValue(meter.used, unit) : "—",
    requestedReal ? formatValue(meter.requested, unit) : "—",
    formatValue(allocatable, unit),
  ].join(" / ")

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
          {label}
        </span>
        <span className="text-right font-mono text-meta text-neutral-800">
          {readout} {unitName(unit)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} — used ${usedReal ? `${Math.round(usedPercent)} percent` : "not available"}, requested ${requestedReal ? `${Math.round(requestedRatio * 100)} percent` : "not available"} of allocatable`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedReal ? Math.round(usedPercent) : undefined}
        className="relative mt-1 h-[9px] border border-rule bg-neutral-200"
      >
        {usedReal ? (
          <span
            style={{ width: `${usedPercent}%` }}
            className={cn(
              "absolute inset-y-0 left-0",
              hot ? "bg-status-degraded-line" : "bg-primary"
            )}
          />
        ) : null}
        {requestedReal ? (
          <span
            style={{ left: `${Math.min(100, requestedRatio * 100)}%` }}
            className={cn(
              "absolute -top-[3px] -bottom-[3px] w-0.5",
              hot ? "bg-status-failed-text" : "bg-foreground"
            )}
          />
        ) : null}
      </div>
      <div className="mt-0.5 flex justify-between gap-2 font-mono text-kicker">
        <span className="text-neutral-500">
          {usedReal ? `used ${Math.round(usedPercent)}%` : "used unavailable"}
        </span>
        <span
          className={cn(
            hot ? "font-bold text-status-failed-text" : "text-neutral-500"
          )}
        >
          {requestedReal
            ? `requested ${Math.round(requestedRatio * 100)}%`
            : "requested unavailable"}
        </span>
      </div>
      {!usedReal && meter.unavailableReason ? (
        <UnavailableNote className="mt-1" reason={meter.unavailableReason} />
      ) : null}
    </div>
  )
}
