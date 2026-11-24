import { describe, expect, it } from "vitest";
import { suggestedPresetIds, thresholdPresets } from "./threshold-presets";

const preset = (id: string) => thresholdPresets.find((entry) => entry.id === id)!;

describe("threshold presets", () => {
  it.each(thresholdPresets.map((entry) => [entry.id, ["%", "ms", "s", "x", ""]] as const))(
    "%s writes ascending, status-only bands with no colour when built",
    (id, units) => {
      for (const unit of units) {
        const bands = preset(id).build(unit)
        if (bands === undefined) continue
        expect(bands.length).toBeGreaterThan(0)
        expect(bands[0].value).toBe(0)
        for (let index = 1; index < bands.length; index++) expect(bands[index].value).toBeGreaterThan(bands[index - 1].value)
        for (const band of bands) {
          expect(band.status).toBeDefined()
          expect(band.color).toBeUndefined()
        }
      }
    },
  )

  it("uses a 0 to 100 scale for a percentage unit and ratios otherwise", () => {
    expect(preset("availability").build("%")!.map((band) => band.value)).toEqual([0, 99, 99.9])
    expect(preset("availability").build("")!.map((band) => band.value)).toEqual([0, 0.99, 0.999])
    expect(preset("errorRatio").build("%")!.map((band) => band.value)).toEqual([0, 1, 5])
    expect(preset("errorRatio").build("")!.map((band) => band.value)).toEqual([0, 0.01, 0.05])
    expect(preset("saturation").build("%")!.map((band) => band.value)).toEqual([0, 70, 90])
    expect(preset("saturation").build("ratio")!.map((band) => band.value)).toEqual([0, 0.7, 0.9])
  });

  it("gives latency a scale for milliseconds and seconds only", () => {
    expect(preset("latency").build("ms")!.map((band) => band.value)).toEqual([0, 300, 1000]);
    expect(preset("latency").build("s")!.map((band) => band.value)).toEqual([0, 0.3, 1]);
    expect(preset("latency").build("")).toBeUndefined();
    expect(preset("latency").build("%")).toBeUndefined();
  });

  it("suggests presets from the unit", () => {
    expect(suggestedPresetIds("%")).toEqual(["availability", "errorRatio", "saturation"]);
    expect(suggestedPresetIds("ms")).toEqual(["latency"]);
    expect(suggestedPresetIds("s")).toEqual(["latency"]);
    expect(suggestedPresetIds("x")).toEqual(["burnRate"]);
    expect(suggestedPresetIds("req/s")).toEqual([]);
  });
});
