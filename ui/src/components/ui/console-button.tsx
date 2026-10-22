import { cn } from "@/lib/utils"

export type ConsoleButtonTone = "primary" | "secondary" | "destructive"

/**
 * The console's action button: square, hairline-bordered, and sized for a
 * dense board rather than a marketing page. The tone names the consequence —
 * primary for the one action a board is about, destructive for the one that
 * undoes something.
 */
export function ConsoleButton({
  tone = "secondary",
  className,
  ...props
}: { tone?: ConsoleButtonTone } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 border px-3.5",
        "font-cond text-label leading-[1.2] font-medium whitespace-nowrap",
        "pointer-coarse:h-11 pointer-coarse:px-4",
        "disabled:cursor-not-allowed disabled:opacity-45",
        tone === "primary" &&
          "border-primary bg-primary text-primary-foreground hover:bg-steel-700",
        tone === "secondary" &&
          "border-rule bg-card text-foreground hover:bg-inset",
        tone === "destructive" &&
          "border-status-failed-line bg-card text-status-failed-text hover:bg-status-failed-fill",
        className,
      )}
      {...props}
    />
  )
}
