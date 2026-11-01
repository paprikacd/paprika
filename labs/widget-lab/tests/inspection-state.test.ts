import { describe, expect, it } from 'vitest';
import { resolveInspectionState } from '../src/charts/shared/inspection-state';

const firstResult = {}, replacementResult = {};
const observations = [
  { id: 'replica-eu-2@100', replica: 'eu-2', value: 84 },
  { id: 'replica-us-1@100', replica: 'us-1', value: 12 },
];
const key = (item: typeof observations[number]) => item.replica;
const pin = { pinned: observations[0].id, hover: observations[1].id };

describe('inspection ownership across linked dashboard updates', () => {
  it('dismisses an obsolete pin even when the new result echoes its selected entity', () => {
    expect(resolveInspectionState(pin,
      { revision: firstResult, externalSelection: 'us-1' },
      { revision: replacementResult, externalSelection: 'eu-2' },
      [{ ...observations[0], value: 241 }], true, key,
    )).toEqual({ hover: null, pinned: null });
  });

  it('retains a deliberate pin when its own linked selection is echoed against the same result', () => {
    expect(resolveInspectionState(pin,
      { revision: firstResult }, { revision: firstResult, externalSelection: 'eu-2' },
      observations, true, key,
    )).toEqual({ hover: null, pinned: observations[0].id });
  });

  it('dismisses pin and transient evidence when another panel selects a different entity', () => {
    expect(resolveInspectionState(pin,
      { revision: firstResult, externalSelection: 'eu-2' },
      { revision: firstResult, externalSelection: 'us-1' }, observations, true, key,
    )).toEqual({ hover: null, pinned: null });
  });

  it('releases a filtered-out pin so an available hovered observation remains inspectable', () => {
    const source = { revision: firstResult, externalSelection: 'eu-2' };
    const resolved = resolveInspectionState(pin, source, source, observations.slice(1), true, key);
    expect(resolved).toEqual({ hover: observations[1].id, pinned: null });
    expect(resolveInspectionState(resolved, source, source, observations, true, key).pinned).toBeNull();
  });

  it('preserves stable identity through reordering and clears all evidence when inspection is disabled', () => {
    const source = { revision: firstResult };
    expect(resolveInspectionState(pin, source, source, [...observations].reverse(), true, key)).toEqual(pin);
    expect(resolveInspectionState(pin, source, source, observations, false, key)).toEqual({ hover: null, pinned: null });
  });
});
