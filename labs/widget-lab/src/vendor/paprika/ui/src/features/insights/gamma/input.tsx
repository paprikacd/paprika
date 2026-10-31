// Native field adapter of Gamma FloatingField/SearchField token and state contract.
import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import styles from "./controls.module.css";

export type GammaInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> & { size?: "sm" | "md" };

export const GammaInput = forwardRef<HTMLInputElement, GammaInputProps>(
  function GammaInput(
    { size = "md", className = "", type = "text", ...props },
    ref,
  ) {
    const plain = type === "hidden" || type === "file";
    return (
      <input
        {...props}
        ref={ref}
        type={type}
        data-size={plain ? undefined : size}
        className={`${plain ? "" : styles.input} ${className}`.trim()}
      />
    );
  },
);

export const GammaTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function GammaTextarea({ className = "", ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={`${styles.input} ${styles.textarea} ${className}`}
    />
  );
});
