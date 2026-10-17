// Build the two standalone isometric figures for the static landing page.
// Geometry and shading use Anatomy (MIT); interaction is intentionally small and local.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as k from './iso-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const W = 660;
const H = 370;
const plate = { x: -150, y: -65, w: 300, d: 130, r: 8 };
const stationX = [-88, 0, 88];
const P = k.fitProjection([...k.boxCorners(plate, -20, 0), [-110, -34, 65], [110, 34, 65]], W, H, { pad: 24, azimuth: 43 });
const S = (shape, options = {}) => k.solidSvg(shape, options);
const L = (path, tone = 'lo') => k.lineSvg(path, { tone });
const D = (points, tone = 'mid') => k.dotsSvg(points.map(point => k.iso(point, P)), { tone, size: .65 });

// A bench, mounted track, three instrument heads, and a sliding inspection carrier.
// The carrier is an analogy for selecting a point in the workflow, not a live status readout.
function bench() {
  const out = [`<path class="iso-halo" d="${k.haloOf(plate, -20, 12, P)}"/>`];
  for (const [x, y] of k.corners(plate, 23)) {
    out.push(S(k.cylinder(x, y, 8, -20, 4, P, 24), { tone: 'lo' }));
    out.push(S(k.cylinder(x, y, 5, -16, 7, P, 24), { tone: 'mid' }));
  }
  out.push(S(k.slabOf(plate, -9, 9, P, 8, 1.3), { tone: 'mid' }));
  out.push(L(k.planOutline(k.insetPlan(plate, 5), 0, P), 'faint'));
  out.push(D(k.corners(plate, 10).map(([x, y]) => [x, y, 0]), 'hi'));
  for (const y of [-30, 25]) {
    out.push(S(k.slabOf({ x: -120, y, w: 240, d: 5, r: 1 }, 0, 4, P, 3, .5), { tone: 'mid' }));
    out.push(D([-112, -40, 40, 112].map(x => [x, y + 2, 4]), 'lo'));
  }
  for (const x of [-126, 122]) {
    out.push(S(k.slabOf({ x, y: -34, w: 5, d: 66, r: 1 }, 0, 8, P, 3), { tone: 'mid' }));
    out.push(D([[-28, 8], [26, 8]].map(([y, z]) => [x + 2.5, y, z]), 'hi'));
  }
  const ruler = { x: -122, y: 42, w: 244, d: 7, r: 1 };
  out.push(S(k.slabOf(ruler, 0, 1, P, 3), { tone: 'lo' }));
  const ticks = k.topTicks(-116, 116, 8, 5, 43, 1, [2.5, 4.5], P);
  out.push(L(ticks.minor, 'lo'), L(ticks.major, 'mid'));
  return out.join('');
}

function instrument(x, index, mode) {
  const out = [];
  const base = { x: x - 18, y: -50, w: 36, d: 24, r: 3 };
  out.push(S(k.slabOf(base, 0, 5, P, 4, .6), { tone: 'mid' }));
  out.push(D(k.corners(base, 5).map(([bx, by]) => [bx, by, 5]), 'hi'));
  for (const px of [x - 12, x + 12]) {
    out.push(S(k.cylinder(px, -39, 3, 5, 34, P, 20), { tone: 'mid' }));
    out.push(S(k.cylinder(px, -39, 4, 36, 3, P, 20), { tone: 'lo' }));
  }
  const housing = { x: x - 24, y: -50, w: 48, d: 23, r: 3 };
  out.push(S(k.slabOf(housing, 38, 17, P, 4, .6), { tone: 'hi' }));
  out.push(S(k.slabOf(k.insetPlan(housing, 4), 55, 2, P, 4), { tone: index === 1 ? 'hi' : 'mid', lit: index === 1 }));
  out.push(L(k.planOutline(k.insetPlan(housing, 6), 57, P), index === 1 ? 'lit' : 'faint'));
  out.push(D([x - 18, x + 18].flatMap(px => [[px, -46, 55], [px, -31, 55]]), 'hi'));
  out.push(S(k.slabOf({ x: x - 4, y: -27, w: 8, d: 9, r: 1 }, 35, 3, P, 3), { tone: 'mid' }));
  out.push(S(k.cylinder(x, -21, 3, 23, 13, P, 20), { tone: 'mid' }));
  out.push(S(k.cylinder(x, -21, 5, 20, 3, P, 24), { tone: 'lo' }));
  // Small front switch and two closed display slots are functional fixtures, not random texture.
  out.push(S(k.slabOf({ x: x - 19, y: -20, w: 38, d: 10, r: 2 }, 0, 3, P, 3), { tone: 'lo' }));
  for (const sx of [x - 10, x + 6]) out.push(S(k.slabOf({ x: sx, y: -17, w: 5, d: 3, r: .5 }, 3, 1, P, 3), { tone: 'mid' }));
  if (mode === 'gates.html' && index === 1) {
    // The bridge and thumbwheel make the optional manual gate a visible latch.
    for (const px of [x - 18, x + 18]) out.push(S(k.slabOf({ x: px - 3, y: -11, w: 6, d: 18, r: 1 }, 3, 19, P, 3), { tone: 'mid' }));
    out.push(S(k.slabOf({ x: x - 21, y: -11, w: 42, d: 7, r: 1 }, 22, 5, P, 3), { tone: 'hi' }));
    out.push(S(k.cylinder(x, -7, 7, 27, 4, P, 32), { tone: 'hi', lit: true }));
    out.push(L(k.ring(x, -7, 4.5, 31, P, 24), 'lit'));
    out.push(D([[x - 17, -8, 27], [x + 17, -8, 27]], 'hi'));
  }
  out.push(k.faceTextSvg(k.topMatrix([x, -37], 57, P), `${index + 1}`, { size: 5, tone: 'hi', anchor: 'middle' }));
  return out.join('');
}

function carrier() {
  const out = [];
  const sled = { x: -111, y: -24, w: 46, d: 47, r: 3 };
  for (const x of [-105, -71]) for (const y of [-20, 20]) {
    out.push(S(k.slabOf({ x: x - 5, y: y - 4, w: 10, d: 8, r: 1 }, 4, 3, P, 3), { tone: 'lo' }));
  }
  out.push(S(k.slabOf(sled, 7, 5, P, 4, .8), { tone: 'hi', lit: true }));
  out.push(L(k.planOutline(k.insetPlan(sled, 4), 12, P), 'lit'));
  out.push(S(k.slabOf({ x: -99, y: -12, w: 22, d: 23, r: 2 }, 12, 9, P, 4, .5), { tone: 'hi', lit: true }));
  out.push(S(k.slabOf({ x: -95, y: -8, w: 14, d: 15, r: 1 }, 21, 1, P, 3), { tone: 'mid' }));
  out.push(D([[-105,-15,12],[-71,-15,12],[-105,15,12],[-71,15,12]], 'hi'));
  return k.groupSvg(out, { id: 'inspection-carrier', transform: k.translateAlong(P, [0, 0, 0]) });
}

const figures = [
  {
    file: 'pipeline.html', fig: 'FIG. 01 / PIPELINE', title: 'A pipeline on the bench',
    hint: 'Select a station', label: 'Build',
    steps: [
      ['Source', 'A Git source can be checked out before container steps run.'],
      ['Steps', 'Container steps can declare dependencies and run in parallel.'],
      ['Result', 'The operator records the declared artifact reference.'],
    ],
    caption: 'An illustration of the documented Pipeline resource; station selection does not represent a running pipeline.',
  },
  {
    file: 'gates.html', fig: 'FIG. 02 / PROMOTION', title: 'A staged release on the bench',
    hint: 'Select a station', label: 'Verify',
    steps: [
      ['Verify', 'A stage can evaluate an HTTP smoke test or a duration gate.'],
      ['Approve', 'A configured manual gate waits for an approval action.'],
      ['Continue', 'After required gates pass, promotion can resume to the next stage.'],
    ],
    caption: 'Gates are configured per stage or Application; manual approval is optional.',
  },
];

for (const config of figures) {
  const machine = bench() + stationX.map((x, i) => instrument(x, i, config.file)).join('') + carrier();
  const svg = k.figureSvg({ width: W, height: H, label: `${config.title}: an isometric three-station instrument with a selectable carrier`, body: machine });
  const buttons = config.steps.map(([name], i) => `<button type="button" data-step="${i}" aria-pressed="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${String(i + 1).padStart(2,'0')} <span>${name}</span></button>`).join('');
  const text = config.steps.map(([, body]) => body);
  const offsets = stationX.map(x => k.translateAlong(P, [x - stationX[0], 0, 0]));
  const card = k.plateHtml({ fig: config.fig, title: config.title, hint: config.hint, readout: `01 / ${config.steps[0][0]}`, body: svg,
    keys: [{ mark: 'lit', label: 'Selected station' }, { mark: 'raised', label: 'Fixed instrument' }], caption: config.caption });
  const js = `const buttons=[...document.querySelectorAll('[data-step]')];const carrier=document.getElementById('inspection-carrier');const readout=document.querySelector('[data-readout]');const description=document.getElementById('station-description');const offsets=${JSON.stringify(offsets)};const details=${JSON.stringify(text)};const labels=${JSON.stringify(config.steps.map(([name]) => name))};function select(i,focus=false){buttons.forEach((button,n)=>{button.setAttribute('aria-pressed',String(i===n));button.tabIndex=i===n?0:-1});carrier.setAttribute('transform',offsets[i]);readout.textContent=String(i+1).padStart(2,'0')+' / '+labels[i];description.textContent=details[i];if(focus)buttons[i].focus()}buttons.forEach((button,i)=>{button.addEventListener('click',()=>select(i));button.addEventListener('keydown',event=>{let n={ArrowRight:(i+1)%buttons.length,ArrowLeft:(i-1+buttons.length)%buttons.length,Home:0,End:buttons.length-1}[event.key];if(n===undefined)return;event.preventDefault();select(n,true)})});`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.title} · Paprika</title><style>${k.ISO_CSS}
    *{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:transparent;color:#cfc1b8;font:14px/1.55 system-ui,sans-serif}.iso{--anatomy-card:#171513;--anatomy-paper:#171513;--anatomy-face:#211b17;--anatomy-top:#29231e;--anatomy-lit-top:#503021;--anatomy-lit-shade:#362219;--anatomy-lit:#ee8057;--anatomy-hi:#decbbf;--anatomy-mid:#8c786e;--anatomy-lo:#584c46;--anatomy-faint:#3c3430;--anatomy-dot:#e5b394}.iso-figure{margin:0}.iso-plate{padding:38px 8px 29px;border:1px solid #423a33;border-radius:12px;box-shadow:none}.iso-plate-corners{inset:14px 16px}.iso-plate-corner{font-size:9px}.iso-plate-corner[data-corner="readout"]{color:#ee8057}.iso-legend{margin:10px 4px 0;font-size:11px}.controls{display:flex;gap:7px;margin:16px 0 0}.controls button{flex:1;min-height:42px;border:1px solid #493a32;border-radius:7px;background:#211c19;color:#bcaea5;font:10px ui-monospace,monospace;cursor:pointer}.controls button span{font:600 12px system-ui,sans-serif;margin-left:5px}.controls button[aria-pressed="true"]{background:#df7754;border-color:#df7754;color:#1a120e}.controls button:focus-visible{outline:2px solid #fff;outline-offset:2px}#station-description{margin:12px 3px 0;min-height:2.8em;color:#bcaea5;font-size:12px;line-height:1.5}#inspection-carrier{transition:transform .65s cubic-bezier(.2,.7,.2,1)}@media(max-width:520px){.iso-plate{padding:42px 2px 48px}.iso-plate-corner[data-corner="title"]{display:none}.controls button span{display:block;margin:2px 0 0}.iso-legend{font-size:10px}}@media(prefers-reduced-motion:reduce){#inspection-carrier{transition:none}}
    </style></head><body class="iso"><main>${card}<div class="controls" role="group" aria-label="${config.title} stations">${buttons}</div><p id="station-description" role="status" aria-live="polite">${text[0]}</p></main><script>${js}</script></body></html>`;
  writeFileSync(join(here, config.file), html);
  console.log(`${config.file}: ${Buffer.byteLength(html)} bytes`);
}
