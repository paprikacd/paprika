// Adapted from Gamma src/components/GammaSwitch.tsx; see README.md.
import styles from "./gamma.module.css";
export function GammaSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={styles["switch-row"]}>
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles["switch-track"]} aria-hidden="true">
        <span />
      </span>
    </label>
  );
}
