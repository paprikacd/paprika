// Adapted from Gamma src/components/GammaButton.tsx and library.css. See README.md.
import { forwardRef, type ButtonHTMLAttributes } from "react";
import styles from "./controls.module.css";

export interface GammaButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "quiet" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  /** Use only when the visible content is an icon and aria-label names the action. */
  iconOnly?: boolean;
}

export const GammaButton = forwardRef<HTMLButtonElement, GammaButtonProps>(
  function GammaButton(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      iconOnly = false,
      children,
      disabled,
      className = "",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={`${styles.button} ${className}`}
        data-gamma-button=""
        data-variant={variant === "ghost" ? "quiet" : variant}
        data-size={size}
        data-icon-only={iconOnly || undefined}
        disabled={disabled || loading}
        aria-busy={loading || props["aria-busy"]}
      >
        {loading && <span className={styles.spinner} aria-hidden="true" />}
        {children}
      </button>
    );
  },
);
