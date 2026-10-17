import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import * as A from "./kit/audit.mjs";
import { turning } from "./kit/turn-build.mjs";
import * as TA from "./kit/turn-audit.mjs";

// Release proof press: original Paprika-specific geometry, not an Anatomy example.
// One serial die turns; three independent Application cassettes remain fixed.
const HERE = dirname(fileURLToPath(import.meta.url));
const W = 900;
const H = 520;
const AZIMUTH = 44;
const ELEVATION = 32;
const BASE = { x: -105, y: -77, w: 210, d: 160, r: 7 };
const FOOT_Z = -11;
const BASE_Z = -7;
const BED_Z = 0;
const DIE_AT = [-68, 1.5];
const BAY_X = [-68, 0, 68];
const BAY_Y = 41;
const VERT = (x, y) => G.frameOf([x, y, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
const at = (p) => k.iso(p, P);
const S = (paths, options = {}) => k.solidSvg(paths, options);
const L = (path, tone = "lo") => k.lineSvg(path, { tone });
const D = (points, tone = "mid", size = 0.5) => k.dotsSvg(points, { tone, size });

export const P = k.fitProjection(
  [...k.boxCorners(BASE, FOOT_Z, 0), [-34, -28, 36], [34, -28, 36]],
  W,
  H,
  { pad: 40, azimuth: AZIMUTH, elevation: ELEVATION },
);

// The press bed is deliberately static. An Application is installed in a bay;
// the die's turn changes only which candidate is being explained by this figure.
const statics = [];
const add = (name, xyz, svg, rank = 0) => statics.push({ name, xyz, svg, rank });
const slab = (name, plan, z, h, options = {}) => {
  const paths = k.slabOf(plan, z, h, P, options.steps ?? 5, options.bevel ?? 0.7);
  const part = S(paths, {
    tone: options.tone ?? "mid",
    crease: options.crease ?? "faint",
    lit: options.lit ?? false,
    inner: options.inner ?? "",
  });
  add(name, [plan.x + plan.w / 2, plan.y + plan.d / 2, z], options.material ? `<g data-mat="${options.material}">${part}</g>` : part, options.rank ?? 0);
};
const cyl = (name, x, y, r, z, h, options = {}) => {
  const part = S(k.cylinder(x, y, r, z, h, P, 24, options.bevel ?? 0.4), {
    tone: options.tone ?? "mid",
    crease: options.crease ?? "faint",
    lit: options.lit ?? false,
  });
  add(name, [x, y, z], options.material ? `<g data-mat="${options.material}">${part}</g>` : part, options.rank ?? 0);
};

function pressBed() {
  // Eight isolated pads, a cast base, inset bed, two seam rails, real fasteners.
  for (const [i, [x, y]] of k.corners(BASE, 16).entries()) {
    cyl(`foot.${i}.shoe`, x, y, 5.2, FOOT_Z, 1.4, { tone: "lo", rank: -30 });
    cyl(`foot.${i}.post`, x, y, 3.2, FOOT_Z + 1.4, 2.6, { tone: "mid", rank: -29 });
  }
  slab("cast.bed", BASE, BASE_Z, -BASE_Z, { tone: "mid", bevel: 1.4, rank: -20 });
  const inset = k.insetPlan(BASE, 4.5);
  add("cast.groove", [0, 0, BED_Z], L(k.planOutline(inset, BED_Z + 0.08, P, 6), "faint"), -17);
  for (const [i, [x, y]] of k.corners(BASE, 9).entries()) {
    add(`cast.screw.${i}`, [x, y, 0.2], L(k.ring(x, y, 1.8, 0.2, P, 18), "lo") + D([at([x, y, 0.2])], "mid", 0.48), -16);
  }
  // Machined guide rails are physically attached to the bed, outside the die.
  for (const [i, x] of [-95, 95].entries()) {
    slab(`edge.rail.${i}`, { x: x - 1.8, y: -62, w: 3.6, d: 124, r: 0.6 }, 0, 2.1, { tone: "lo", rank: -13 });
  }
  slab("cast.serial.plaque", { x: -22, y: -70, w: 44, d: 7, r: 0.8 }, 0, 1, { tone: "hi", rank: -12 });
  add("cast.serial.rules", [0, -66, 1.1], L([
    k.lineOnTop([-16, -66], [-8, -66], 1.1, P),
    k.lineOnTop([-5, -66], [5, -66], 1.1, P),
    k.lineOnTop([8, -66], [16, -66], 1.1, P),
  ].join(""), "mid"), -11);
  // Two continuous steel ways and three detent sockets connect the head to
  // all three bays. The carriage below will slide on these ways.
  for (const [i, y] of [-10.2, 12.8].entries()) {
    slab(`gantry.way.${i}`, { x: -93, y, w: 186, d: 2.8, r: 0.6 }, 0, 2.3, { tone: "mid", rank: -10 });
    add(`gantry.way.rule.${i}`, [0, y + 1.4, 2.5], L(k.lineOnTop([-87, y + 1.4], [87, y + 1.4], 2.5, P), "faint"), -9);
  }
  for (const [i, x] of BAY_X.entries()) {
    slab(`gantry.detent.${i}`, { x: x - 2.2, y: -12.5, w: 4.4, d: 2, r: 0.3 }, 0, 1.2, { tone: "hi", rank: -8 });
  }
  // The rear ruler and its three coarse witness marks serve the translating
  // carriage. They occupy a real rail, rather than floating UI labels.
  slab("gantry.ruler", { x: -92, y: -61, w: 184, d: 10, r: 0.9 }, 0, 1.4, { tone: "mid", rank: -7 });
  const ticks = [];
  for (let x = -84; x <= 84; x += 4) {
    const major = (x + 84) % 20 === 0;
    ticks.push(k.lineOnTop([x, -59.2], [x, major ? -54 : -56.4], 1.5, P));
  }
  add("gantry.ruler.ticks", [0, -56, 1.5], L(ticks.join(""), "mid"), -6);
  for (const [i, x] of BAY_X.entries()) {
    slab(`gantry.ruler.witness.${i}`, { x: x - 1.5, y: -51.8, w: 3, d: 2.1, r: 0.3 }, 0, 1.9, { tone: "hi", rank: -5 });
  }
  slab("gantry.follower.way", { x: -93, y: -38, w: 186, d: 4, r: 0.8 }, 0, 3.2, { tone: "lo", rank: -4 });
  for (const [i, x] of [-90, 90].entries()) {
    cyl(`gantry.follower.end.${i}`, x, -36, 3.9, 0, 4.6, { tone: "mid", rank: -3 });
  }
}

// Each bay has its own deck, guide, cassette, stage marker, pins and probes.
// The three cassettes are fixed; no common Application is "moved" through them.
function applicationBay(cx, number) {
  const y = BAY_Y;
  const z = 0;
  const frame = { x: cx - 25, y: y - 21, w: 50, d: 47, r: 2.4 };
  const shell = { x: cx - 17, y: y - 15, w: 34, d: 34, r: 1.5 };
  const face = { x: cx - 14, y: y - 12, w: 28, d: 28, r: 0.9 };
  slab(`bay.${number}.bed`, frame, z, 2.3, { tone: "lo", rank: -2 });
  slab(`bay.${number}.backstop`, { x: cx - 23, y: y + 20.5, w: 46, d: 2.8, r: 0.4 }, 2.3, 7, { tone: "mid", rank: -1 });
  for (const [side, x] of [["l", cx - 21], ["r", cx + 18]]) {
    slab(`bay.${number}.rail.${side}`, { x, y: y - 16, w: 3.2, d: 35, r: 0.5 }, 2.3, 3, { tone: "mid", rank: 0 });
    cyl(`bay.${number}.stop.${side}`, x + 1.6, y - 17.5, 2.2, 2.3, 3.4, { tone: "lo", rank: 1 });
  }
  slab(`bay.${number}.cassette`, shell, 2.3, 7.5, { tone: "hi", bevel: 0.9, material: "steel", rank: 2 });
  slab(`bay.${number}.face`, face, 9.8, 0.8, { tone: "lo", bevel: 0.2, rank: 3 });
  slab(`bay.${number}.lip`, { x: cx - 15, y: y - 16.5, w: 30, d: 3.1, r: 0.6 }, 7.8, 4.7, { tone: "mid", material: "gunmetal", rank: 4 });
  for (const [i, px] of [cx - 10, cx, cx + 10].entries()) {
    slab(`bay.${number}.screen.slot.${i}`, { x: px - 3.2, y: y + 1.5, w: 6.4, d: 10, r: 0.6 }, 10.6, 0.22, { tone: i === number ? "hi" : "lo", rank: 5 });
    add(`bay.${number}.slot.rule.${i}`, [px, y + 5, 10.9], L(k.lineOnTop([px - 1.5, y + 5], [px + 1.5, y + 5], 10.9, P), "mid"), 6);
  }
  for (const [side, px] of [["health", cx - 10.2], ["sync", cx + 10.2]]) {
    cyl(`bay.${number}.${side}.socket`, px, y + 17, 3.2, 2.3, 2, { tone: "mid", material: "gunmetal", rank: 7 });
    cyl(`bay.${number}.${side}.probe`, px, y + 17, 1.15, 4.3, 8, { tone: "hi", material: "steel", rank: 8 });
    cyl(`bay.${number}.${side}.lens`, px, y + 17, 2.15, 12.3, 1.15, { tone: "hi", material: "chrome", lit: number === 1, rank: 9 });
  }
  // Stage marker: three machining grooves, never fake telemetry values.
  const grooves = Array.from({ length: number + 1 }, (_, i) => k.lineOnTop([cx - 6 + i * 6, y - 10], [cx - 6 + i * 6, y - 4], 10.85, P));
  add(`bay.${number}.stage.mark`, [cx, y - 7, 10.9], L(grooves.join(""), "mid"), 10);
  // Numbered plates identify independent bays without synthetic metrics.
  add(`bay.${number}.number`, [cx + 6.2, y - 7.4, 10.9], k.faceTextSvg(k.topMatrix([cx + 6.2, y - 7.4], 10.9, P), String(number + 1).padStart(2, "0"), { size: 4.3, tone: "hi", anchor: "middle" }), 10);
  for (const [i, [px, py]] of k.corners(frame, 5.5).entries()) {
    add(`bay.${number}.screw.${i}`, [px, py, 2.4], L(k.ring(px, py, 1.1, 2.4, P, 14), "lo") + D([at([px, py, 2.4])], "mid", 0.38), 11);
  }
}

pressBed();
BAY_X.forEach(applicationBay);

export const T = turning(P);
const carriage = T.group("carriage", { slide: { direction: [1, 0, 0], travel: 136 } });
const die = T.group("die", { parent: carriage, turn: { pivot: DIE_AT } });
const live = T.layer("die");
T.stack(["back", "die"]);
const COMMON = { group: die, layer: live, tone: "hi", crease: "lo" };

// The platform, shoes and bearing translate together, but do not turn with
// the serial die. Their position is indexed to the selected Application bay.
T.prism({ name: "gantry.carriage", group: carriage, layer: live,
  plan: { x: DIE_AT[0] - 12.4, y: DIE_AT[1] - 13.5, w: 24.8, d: 27, r: 1.4 },
  z: 3.5, h: 2.4, bevel: 0.6, tone: "mid", material: "steel" });
T.prism({ name: "gantry.follower.arm", group: carriage, layer: live,
  plan: { x: DIE_AT[0] - 3.1, y: -34, w: 6.2, d: 22, r: 0.8 },
  z: 3.5, h: 2.4, tone: "mid", material: "gunmetal" });
T.prism({ name: "gantry.follower.shoe", group: carriage, layer: live,
  plan: { x: DIE_AT[0] - 5.3, y: -38, w: 10.6, d: 4, r: 0.8 },
  z: 3.2, h: 2.7, tone: "hi", material: "steel" });
for (const [i, y] of [DIE_AT[1] - 11.6, DIE_AT[1] + 11.6].entries()) {
  T.prism({ name: `gantry.slider.${i}`, group: carriage, layer: live,
    plan: { x: DIE_AT[0] - 7.3, y: y - 1.4, w: 14.6, d: 2.8, r: 0.6 },
    z: 2.3, h: 1.2, tone: "lo", material: "gunmetal" });
}
T.round({ name: "gantry.bearing.flange", group: carriage, layer: live, F: VERT(...DIE_AT), s0: 5.9, s1: 7.1, r: 11.8, material: "gunmetal" });
T.round({ name: "gantry.bearing.barrel", group: carriage, layer: live, F: VERT(...DIE_AT), s0: 7.1, s1: 8.1, r: 8.2, material: "chrome" });

// The die's three non-axisymmetric arms are newly authored convex solids;
// they re-project and re-shade at every angle through Anatomy TURN.mount.
T.round({ name: "die.lower.bearing", ...COMMON, F: VERT(...DIE_AT), s0: 8.1, s1: 10.2, r: 10.8, material: "gunmetal", details: { seams: [9.05] } });
T.round({ name: "die.lower.disc", ...COMMON, F: VERT(...DIE_AT), s0: 10.2, s1: 13.0, r: 24.6, material: "steel", details: { ribs: { s0: 10.5, s1: 12.6, count: 72, seams: true, tone: "lo" } } });

const radial = (angle, along, aside) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [DIE_AT[0] + c * along - s * aside, DIE_AT[1] + s * along + c * aside];
};
for (let n = 0; n < 3; n++) {
  const phi = (n * Math.PI * 2) / 3;
  const polygon = [[13.4, -5.2], [29.7, -5.2], [32.2, 0], [29.7, 5.2], [13.4, 5.2]].map(([r, side]) => radial(phi, r, side));
  T.prism({ name: `die.shoe.${n}`, ...COMMON,
    F: { o: [0, 0, 0], a: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    polygon, s0: 13.0, s1: 17.0, bevel: 0.55,
    material: n === 0 ? "steel" : "gunmetal",
  });
  const [x, y] = radial(phi, 25.0, 0);
  T.round({ name: `die.shoe.${n}.pin`, ...COMMON, F: VERT(x, y), s0: 17.0, s1: 18.1, r: 2.55, material: "chrome", details: { bolts: [{ s: 18.1, r: 0, count: 1, size: 0.48 }] } });
  const [ix, iy] = radial(phi, 19.4, 0);
  T.prism({ name: `die.shoe.${n}.index`, ...COMMON,
    plan: { x: ix - 1.5, y: iy - 1.5, w: 3, d: 3, r: 0.3 },
    z: 17, h: 0.48, bevel: 0.18, material: "brass", tone: "mid" });
}

T.round({ name: "die.crown.neck", ...COMMON, F: VERT(...DIE_AT), s0: 13, s1: 17.5, r: 13.2, material: "gunmetal" });
const crown = T.round({ name: "die.crown.face", ...COMMON, F: VERT(...DIE_AT), s0: 17.5, s1: 20.6, r: [13.2, 11.1], material: "steel", details: { bolts: [{ s: 20.6, r: 7.6, count: 6, size: 0.56, tone: "mid" }] } });
T.plane({ part: crown, o: [DIE_AT[0], DIE_AT[1], 20.6], u: [1, 0, 0], v: [0, 1, 0],
  svg: `<circle cx="0" cy="0" r="7.1" fill="none" class="iso-line" data-tone="mid"/><text class="iso-face-text" data-tone="hi" font-size="4.5" text-anchor="middle" y="1.6">SHA</text>` });
T.round({ name: "die.crown.key", ...COMMON, F: VERT(...DIE_AT), s0: 20.6, s1: 22.1, r: 2.25, material: "brass" });

const POSES = Array.from({ length: 25 }, (_, i) => ({ carriage: 136 * i / 24, die: 90 - i * 10 }));
const verify = process.argv.includes("--verify");
export const out = T.build({ statics: [], poses: POSES, verify });
const sorted = statics.sort((a, b) => a.rank - b.rank || k.depthOf(a.xyz, P) - k.depthOf(b.xyz, P));
const baseSvg = k.figureSvg({ width: W, height: H,
  label: "A custom isometric release proof indexer: three independent Application cassettes remain on the bed while a carriage travels to each bay and a three-shoe SHA die turns above its bearing.",
  body: [`<path class="iso-halo" d="${k.haloOf(BASE, FOOT_Z, 1, P)}"/>`, ...sorted.map((item) => {
    const bay = item.name.match(/^bay\.(\d)\./)?.[1];
    return bay === undefined ? item.svg : `<g data-bay-id="${bay}"${bay === "0" ? " data-selected" : ""}>${item.svg}</g>`;
  })] });
const stage = `<div class="iso-stage iso-turn rp-stage" tabindex="0" role="slider" aria-label="Revision indexer preview. Drag the die or use arrow keys to move the carriage and select the separate dev, staging, or production Application." aria-valuemin="0" aria-valuemax="2" aria-valuenow="0" aria-valuetext="Development Application">${baseSvg}${out.layerSvg("die", { width: W, height: H })}</div>`;
const css = readFileSync(join(HERE, "style.css"), "utf8");
const modelData = { turn: out.data, pivot: [DIE_AT[0], DIE_AT[1], 20.6], pivotScreen: k.iso([DIE_AT[0], DIE_AT[1], 20.6], P) };
const liveJs = readFileSync(join(HERE, "live.js"), "utf8").replace("__TURN_DATA__", JSON.stringify(modelData));
const runtime = readFileSync(join(HERE, "kit/turn.mjs"), "utf8").replace(/^export /gm, "");
const ui = `<div class="rp-shell"><div class="rp-eyebrow"><span>Delivery instrument / 01</span><span>Illustrative mechanism</span></div>${k.plateHtml({
  fig: "Fig 3D", title: "The release proof indexer", hint: "Drag the die · arrow keys · select a bay", readout: "Development Application", body: stage,
  keys: [
    { mark: "raised", label: "Three independent Application cassettes" },
    { mark: "lit", label: "One carriage and turning revision die" },
  ],
  caption: "A configured promotion link selects the exact Git SHA of a completed upstream Release. Each environment has its own Application, Stage, target, and Release. This figure is a local preview, not a deployment control.",
})}<div class="rp-controls" role="group" aria-label="Choose an Application cassette">
  <button type="button" data-bay="0" aria-pressed="true"><b>01</b><span>Development</span><small>GitOps source</small></button>
  <button type="button" data-bay="1" aria-pressed="false"><b>02</b><span>Staging</span><small>from dev Release</small></button>
  <button type="button" data-bay="2" aria-pressed="false"><b>03</b><span>Production</span><small>from staging Release</small></button>
  </div><div class="rp-evidence"><p data-evidence>GitOps selects a source revision for the development Application.</p><label data-inactive><input type="checkbox" data-manual checked disabled> Production only · preview manual hold</label></div><span class="rp-sr" aria-live="polite" data-announce></span></div>`;
const page = k.pageHtml({ title: "Paprika release proof indexer", theme: "light", width: 900,
  body: `<style>${out.css}\n${css}</style>${ui}`,
  script: runtime + "\n" + (verify ? `window.__isoVerify = ${JSON.stringify(out.verify)};\n` : "") + liveJs,
});
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = join(HERE, verify ? "index-verify.html" : "index.html");
  writeFileSync(output, page);
  console.log(`wrote ${output} · ${(page.length / 1024).toFixed(0)} KB · ${out.report.parts} live 3D parts · ${statics.length} static items · ${out.report.seconds.toFixed(1)} s`);
  if (process.argv.includes("--audit")) {
    const R = A.recorder(P);
    TA.orbitOrExit(T, R, P, { sweep: { at: (v) => ({ carriage: 68 * (90 - v) / 120, die: v }), from: -150, to: 90, frame: 1 }, quick: process.argv.includes("--quick"), only: process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",") });
  }
}
