import { Link2 } from "lucide-react";
import { useState } from "react";
import { GammaDisclosure } from "./gamma/disclosure";
import { GammaButton } from "./gamma/button";
import { SearchCombobox } from "./gamma/search-combobox";
import type { ConnectionSuggestion, QueryFields } from "./query-connections";
import styles from "./query-connection-controls.module.css";

export function GraphDataFields({ fields }: { fields?: QueryFields }) {
  if (!fields?.labels.length) return <p className={styles.hint}>Label suggestions appear when the graph has loaded data. You can also enter a label name directly.</p>;
  return <GammaDisclosure title="Available graph data" meta={`${fields.labels.length} labels`}>
    <p className={styles.hint}>From {fields.seriesCount} loaded series{fields.partial ? " (limited result)" : ""}. Connections use the observation you hover or select.</p>
    <dl className={styles.fields}>{fields.labels.map((label) => <div key={label.name}><dt>{label.name}</dt><dd title={label.samples.join(", ")}>{label.samples.map((value) => JSON.stringify(value)).join(", ")}</dd><small>{label.present}/{fields.seriesCount} series</small></div>)}</dl>
  </GammaDisclosure>;
}
export function GraphLabelPicker({ fields, value, onChange, label, disabled }: {
  fields?: QueryFields; value: string; onChange: (value: string) => void; label: string; disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const options = (fields?.labels ?? []).map((field) => ({ value: field.name, label: field.name, description: field.samples.map((sample) => JSON.stringify(sample)).join(", ") }));
  if (value && !options.some((option) => option.value === value)) options.unshift({ value, label: value, description: "Use this label name" });
  if (search && !options.some((option) => option.value === search)) options.unshift({ value: search, label: search, description: "Use this label name" });
  return <SearchCombobox label={label} aria-label={label} value={value || null} options={options} disabled={disabled} maxLength={128}
    placeholder="Choose or enter a graph label" onQueryChange={setSearch} onQueryInput={onChange} onValueChange={(next) => onChange(next ?? "")} openOnFocus />;
}
export function SuggestedConnection({ suggestion, onUse, disabled }: { suggestion: ConnectionSuggestion; onUse: () => void; disabled?: boolean }) {
  return <div className={styles.suggestion}>
    <GammaButton variant="quiet" size="sm" disabled={disabled} onClick={onUse}><Link2 size={13} aria-hidden="true" /><span>{suggestion.label}</span></GammaButton>
    <small title={suggestion.reason}>{suggestion.reason}</small>
  </div>;
}
