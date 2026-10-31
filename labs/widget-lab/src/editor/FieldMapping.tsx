import { Check, CircleAlert, Columns3 } from 'lucide-react';
import { useId } from 'react';
import { GammaSelect } from '../vendor/paprika/ui/src/features/insights/gamma/select';
import type { QueryResult, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import type { WidgetConfigField, WidgetDefinition } from '../vendor/paprika/ui/src/features/insights/widget-registry';
import { bindingMismatch, formatFieldSample, validateFieldBindings, type DiscoveredField } from './field-bindings';

export function FieldMapping({ field, definition, config, result, columns, onChange }: {
  field: WidgetConfigField; definition: WidgetDefinition; config: Widget['config']; result: QueryResult;
  columns: DiscoveredField[]; onChange: (value: string | undefined) => void;
}) {
  const id = useId(), effective = { ...definition.defaultConfig, ...config };
  const value = typeof effective[field.key] === 'string' ? String(effective[field.key]) : '';
  const column = columns.find(item => item.key === value);
  const issue = validateFieldBindings(definition, effective, result).find(item => item.key === field.key);
  const options = columns.map(item => {
    const reason = bindingMismatch(field, item);
    return { value: item.key, label: item.key, disabled: !!reason,
      description: reason ?? `${item.type}${item.unit ? ` · ${item.unit}` : ''} · ${item.observations}/${item.observations + item.missing} present`,
      keywords: [item.label ?? '', item.type, item.unit ?? ''],
      details: !reason && item.samples.length ? <span className="we-binding-option-sample">Sample: {item.samples.map(formatFieldSample).join(', ')}</span> : undefined };
  });
  if (field.binding?.optional) options.unshift({ value: '', label: 'Not mapped', disabled: false, description: 'Optional role', keywords: [], details: undefined });
  if (value && !column) options.unshift({ value, label: `${value} · missing`, disabled: true, description: 'Not in the loaded source', keywords: [], details: undefined });
  return <div className={`we-binding ${issue ? 'has-error' : ''}`}>
    <label id={`${id}-label`}>{field.label}<span>{field.binding?.optional ? 'Optional' : 'Required'}</span></label>
    <GammaSelect aria-labelledby={`${id}-label`} aria-label={field.label} aria-invalid={!!issue} aria-describedby={`${id}-help${issue ? ` ${id}-error` : ''}`} searchable value={value} options={options} onValueChange={next => onChange(next)} placeholder="Choose a source field" size="sm"/>
    <p id={`${id}-help`} className="we-binding-help">{field.binding?.role ?? field.help ?? `Requires ${field.binding?.types.join(' or ')}${field.binding?.unit ? ` in ${field.binding.unit}` : ''}.`}</p>
    {issue ? <p id={`${id}-error`} className="we-binding-error"><CircleAlert size={13}/>{issue.message}</p> : column && <div className="we-binding-facts"><span><Check size={12}/>{column.type}{column.unit ? ` · ${column.unit}` : ''}</span><span>{column.missing ? `${column.missing} missing` : `${column.observations} present`}</span>{column.samples.length > 0 && <code title={column.samples.map(String).join(', ')}>{column.samples.map(formatFieldSample).join(', ')}</code>}</div>}
  </div>;
}

export function SourceSchema({ columns, definition, config, result }: {
  columns: DiscoveredField[]; definition?: WidgetDefinition; config: Widget['config']; result: QueryResult;
}) {
  const fields = definition?.configFields?.filter(field => field.binding) ?? [];
  const effective = { ...definition?.defaultConfig, ...config };
  const issues = definition ? validateFieldBindings(definition, effective, result) : [];
  if (!result.records) return <div className="we-schema-empty"><Columns3 size={22}/><strong>{result.series ? 'Metric-series contract' : 'Trace contract'}</strong><p>{result.series ? 'Series names, labels, exact timestamps and values are available in Data. Column mapping is available for record-based charts.' : 'Trace identity, duration, operation and status are available in Data.'}</p></div>;
  return <div className="we-schema">
    <div className="we-schema-summary"><div><Columns3 size={17}/><strong>{columns.length} source fields</strong><span>{result.records.rows.length.toLocaleString()} loaded rows</span></div><p>Types and units come from source metadata. Coverage and samples describe this result; they do not establish freshness or provider availability.</p></div>
    <div className="we-schema-status" data-invalid={issues.length > 0}><span>{issues.length ? <CircleAlert size={14}/> : <Check size={14}/>} {fields.length ? `${fields.length - issues.length} of ${fields.length} mapped roles valid` : 'Fixed source schema'}</span><span>{definition?.validateInput ? 'Semantic adapter enabled' : 'Structural validation'}</span></div>
    <div className="we-schema-scroll" role="region" aria-label="Discovered source fields" tabIndex={0}><table><thead><tr><th>Field</th><th>Type / unit</th><th>Present</th><th>Bound role</th><th>Sample values</th></tr></thead><tbody>{columns.map(column => <tr key={column.key}><th scope="row"><code>{column.key}</code>{column.label && column.label !== column.key && <small>{column.label}</small>}</th><td><span>{column.type}</span><small>{column.unit ?? 'No declared unit'}</small></td><td><strong>{column.observations}</strong><span> / {column.observations + column.missing}</span>{column.missing > 0 && <small>{column.missing} missing</small>}</td><td>{fields.filter(field => effective[field.key] === column.key).map(field => <span className="we-role-tag" key={field.key}>{field.label}</span>)}</td><td>{column.samples.length ? column.samples.map(value => <code key={`${typeof value}:${String(value)}`} title={String(value)}>{formatFieldSample(value)}</code>) : <span className="we-null">No observed values</span>}</td></tr>)}</tbody></table></div>
  </div>;
}
