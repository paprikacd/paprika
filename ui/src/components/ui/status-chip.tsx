import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * A 16px glyph box. Used where a row, tile or node needs its state readable
 * at a glance without spending horizontal space on a word.
 *
 * The glyph carries the meaning as well as the colour, so the state survives
 * greyscale and the commoner forms of colour blindness. `label` names the
 * state for assistive technology; pass `labelledBy` instead when adjacent
 * text already says it, to avoid reading the state twice.
 */
function StatusGlyph({
  tone,
  label,
  className,
  ...props
}: {
  tone: StatusTone
  label?: string
} & Omit<React.ComponentProps<"span">, "children">) {
  const spec = STATUS_TONES[tone]
  return (
    <span
      data-slot="status-glyph"
      data-tone={tone}
      role="img"
      aria-label={label ?? spec.label}
      className={cn(
        "inline-flex size-4 flex-none items-center justify-center border text-meta leading-none font-bold",
        spec.line,
        spec.fill,
        spec.text,
        className
      )}
      {...props}
    >
      <span aria-hidden>{spec.glyph}</span>
    </span>
  )
}

/**
 * The named state pill — `HEALTHY`, `DRIFTED`, `PROGRESSING`. Pass an
 * explicit `label` where the domain has its own word for the tone: sync
 * calls a degraded state "Drifted", not "Degraded".
 */
function StatusPill({
  tone,
  label,
  className,
  ...props
}: {
  tone: StatusTone
  label?: string
} & Omit<React.ComponentProps<"span">, "children">) {
  const spec = STATUS_TONES[tone]
  return (
    <span
      data-slot="status-pill"
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-[5px] rounded-[2px] border px-[7px] py-px text-meta font-semibold tracking-[0.04em] uppercase",
        spec.line,
        spec.fill,
        spec.text,
        className
      )}
      {...props}
    >
      {label ?? spec.label}
    </span>
  )
}

export { StatusGlyph, StatusPill }
