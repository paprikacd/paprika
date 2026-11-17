import { describe, expect, it } from "vitest";
import { bucketQuantile } from "./distribution-quantile";

describe("bucket quantiles", () => {
  it("interpolates linearly inside the bucket that holds the rank", () => {
    expect(bucketQuantile([10, 20, Infinity], [4, 4, 2], 0.5)).toEqual({ q: 0.5, bucket: 1, lower: 10, upper: 20, estimate: 12.5, overflow: false, total: 10 });
  });
  it("interpolates the first bucket from zero when its bound is positive", () => {
    expect(bucketQuantile([10, 20, Infinity], [10, 0, 0], 0.5)).toMatchObject({ bucket: 0, lower: 0, estimate: 5 });
  });
  it("never invents a value above the last finite bound", () => {
    expect(bucketQuantile([10, Infinity], [1, 9], 0.95)).toEqual({ q: 0.95, bucket: 1, lower: 10, upper: Infinity, estimate: null, overflow: true, total: 10 });
  });
  it("returns null without observations", () => {
    expect(bucketQuantile([10, Infinity], [0, 0], 0.95)).toBeNull();
  });
  it("handles a single finite bucket and a single +Inf bucket", () => {
    expect(bucketQuantile([10], [4], 0.5)).toMatchObject({ bucket: 0, lower: 0, estimate: 5, overflow: false });
    expect(bucketQuantile([Infinity], [7], 0.95)).toMatchObject({ bucket: 0, lower: 0, estimate: null, overflow: true, total: 7 });
  });
  it("places a rank exactly on a boundary at the upper bound of the bucket below", () => {
    expect(bucketQuantile([10, 20, Infinity], [5, 5, 0], 0.5)).toMatchObject({ bucket: 0, estimate: 10 });
    // The +Inf bucket is empty, so q = 1 must not select it even though its cumulative count equals the total.
    expect(bucketQuantile([10, 20, Infinity], [5, 5, 0], 1)).toMatchObject({ bucket: 1, estimate: 20, overflow: false });
  });
  it("starts at the first populated bucket for q = 0", () => {
    expect(bucketQuantile([10, 20, Infinity], [0, 5, 0], 0)).toMatchObject({ bucket: 1, lower: 10, estimate: 10 });
  });
  it("keeps the top rank in the last populated bucket despite floating-point rounding", () => {
    const top = bucketQuantile([1, 2, Infinity], [0.1, 0.2, 0], 1);
    expect(top).toMatchObject({ bucket: 1, overflow: false });
    expect(top?.estimate).toBeCloseTo(2, 12);
  });
  it("rejects malformed distributions instead of estimating from them", () => {
    expect(bucketQuantile([10], [-1], 0.5)).toBeNull();
    expect(bucketQuantile([20, 10], [1, 1], 0.5)).toBeNull();
    expect(bucketQuantile([10, 20], [1], 0.5)).toBeNull();
    expect(bucketQuantile([10], [1], 1.5)).toBeNull();
    expect(bucketQuantile([10], [Number.NaN], 0.5)).toBeNull();
  });
});
