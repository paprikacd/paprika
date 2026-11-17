import { describe, expect, it } from 'vitest';
import { registerEnergyCharts } from '../src/charts/energy/register';
import { buildGridBalance } from '../src/lenses/energy/fixtures';
import { createEditorDraft, reviseEditorDraft, travelEditorDraft } from '../src/editor/editor-model';
import { hasIntrinsicChartLayout } from '../src/charts/intrinsic-chart-families';

registerEnergyCharts();
describe('domain chart editor validates loaded source bindings', () => {
  it('retains invalid text and the prior valid chart, then recovers and supports undo', () => {
    const { flow } = buildGridBalance(), initial = createEditorDraft(flow.widget, flow.result);
    expect(initial.errors).toEqual([]);
    const invalid = reviseEditorDraft(initial, { ...initial.draft, title: 'Grid sources', config: { ...initial.draft.config, valueField: 'missing-power' } }, 'records', flow.result);
    expect(invalid.errors.join(' ')).toContain('missing-power');
    expect(invalid.draft.title).toBe('Grid sources');
    expect(invalid.draft.config?.valueField).toBe('missing-power');
    expect(invalid.preview).toBe(initial.preview);
    const recovered = reviseEditorDraft(invalid, { ...invalid.draft, config: { ...invalid.draft.config, valueField: 'power' } }, 'records', flow.result);
    expect(recovered.errors).toEqual([]);
    expect(recovered.preview.title).toBe('Grid sources');
    const undo = travelEditorDraft(recovered, 'undo', 'records', flow.result);
    expect(undo.errors.join(' ')).toContain('missing-power');
    expect(undo.preview).toBe(recovered.preview);
    expect(hasIntrinsicChartLayout(flow.widget)).toBe(true);
  });
  it('rejects a present but dimensionally incompatible field before promoting a preview', () => {
    const { flow } = buildGridBalance(), initial = createEditorDraft(flow.widget, flow.result);
    const invalid = reviseEditorDraft(initial, { ...initial.draft, config: { ...initial.draft.config, valueField: 'energy' } }, 'records', flow.result);
    expect(invalid.errors.join(' ')).toContain('MW units');
    expect(invalid.preview).toBe(initial.preview);
  });
});
