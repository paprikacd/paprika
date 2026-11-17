import { describe, expect, it } from 'vitest';
import { referenceTimeBudget, referenceTimelineInterval } from '../src/reference/ReferenceReliability';

describe('reference reliability fixture accounting', () => {
  it('reconciles the default 99.96% time-based budget over exactly 30 days', () => {
    const budget = referenceTimeBudget(99.96);
    expect(budget.allowedMinutes).toBe(43.2);
    expect(budget.consumedMinutes).toBeCloseTo(17.28, 8);
    expect(budget.remainingMinutes).toBeCloseTo(25.92, 8);
    expect(budget.remainingPercent).toBeCloseTo(60, 8);
    expect(budget.consumedMinutes + budget.remainingMinutes).toBeCloseTo(budget.allowedMinutes, 10);
  });

  it('preserves a negative allowance when another concept service exhausts its budget', () => {
    const budget = referenceTimeBudget(99.72);
    expect(budget.consumedMinutes).toBeCloseTo(120.96, 8);
    expect(budget.remainingMinutes).toBeCloseTo(-77.76, 8);
    expect(budget.remainingPercent).toBeCloseTo(-180, 8);
  });

  it('formats the illustrative display bins across UTC date boundaries', () => {
    expect(referenceTimelineInterval(0)).toBe('May 01 00:00 to May 01 08:28 UTC');
    expect(referenceTimelineInterval(2)).toBe('May 01 16:56 to May 02 01:24 UTC');
    expect(referenceTimelineInterval(84)).toBe('May 30 15:31 to May 31 00:00 UTC');
  });
});
