"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import styles from "./dashboard-description.module.css";

/**
 * The dashboard description on narrow views: two lines, with More and Less when the text does not fit. The full text
 * stays in the DOM, so it is read in full by screen readers and found by search whatever the clamp shows.
 */
export function ClampedDescription({ text }: { text: string }) {
  const id = useId();
  const body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    // While expanded the clamp is off, so the text always fits and the measurement says nothing. Keep the last answer.
    function measure() {
      if (!element || element.hasAttribute("data-expanded")) return;
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    if (!observer) window.addEventListener("resize", measure);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    let fontsLoaded = true;
    void fonts?.ready.then(() => { if (fontsLoaded) measure(); });
    return () => {
      fontsLoaded = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  const showExpanded = expanded && overflowing;
  return (
    <div className={styles.description}>
      <p
        id={id}
        ref={body}
        className={styles.text}
        data-expanded={showExpanded ? "" : undefined}
      >
        {text}
      </p>
      {overflowing && (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={showExpanded}
          aria-controls={id}
          onClick={() => setExpanded(value => !value)}
        >
          {showExpanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
