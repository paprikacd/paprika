// Two explanatory Paprika instruments, generated with the vendored Anatomy SVG kit.
// The pictures illustrate documented configuration, never a live fleet or a running job.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as k from './iso-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const solid = (shape, tone = 'mid', extra = {}) => k.solidSvg(shape, { tone, ...extra });
const line = (path, tone = 'lo') => k.lineSvg(path, { tone });
const dots = (points, P, tone = 'mid', size = .75) => k.dotsSvg(k.pointsAt(points, P), { tone, size });
const slab = (x, y, w, d, z, h, P, tone = 'mid', bevel = .6) =>
  solid(k.slabOf({ x, y, w, d, r: 1 }, z, h, P, 3, bevel), tone);
const bolt = (x, y, z, P) => solid(k.cylinder(x, y, 1.5, z, 1.1, P, 12), 'hi');
const group = (name, body) => k.groupSvg(body, { class: 'iso-assembly', 'data-assembly': name });
const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bar(a, b, width, z, h, P, tone = 'mid') {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  const nx = -dy / length * width / 2, ny = dx / length * width / 2;
  return solid(k.extrude([
    [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
  ], z, h, P), tone);
}

function pipelineFigure() {
  const W = 760, H = 330;
  const deck = { x: -148, y: -73, w: 296, d: 146, r: 2 };
  const P = k.fitProjection([...k.boxCorners(deck, -19, 0), [-142, -62, 51], [142, 62, 51]], W, H,
    { pad: 24, azimuth: 55, elevation: 28 });
  const base = [`<path class="iso-halo" d="${k.haloOf(deck, -19, 8, P)}"/>`];
  for (const [x, y] of k.corners(deck, 13)) {
    base.push(solid(k.cylinder(x, y, 7, -19, 7, P, 18), 'lo'));
    base.push(solid(k.cylinder(x, y, 5.5, -12, 3, P, 18), 'mid'));
  }
  base.push(solid(k.slabOf(deck, -9, 9, P, 3, 1), 'mid'));
  base.push(line(k.planOutline(k.insetPlan(deck, 5), 0, P, 3), 'faint'));
  base.push(dots(k.corners(deck, 9).map(([x, y]) => [x, y, 0]), P, 'hi'));
  for (const y of [-66, 61]) base.push(slab(-132, y, 264, 5, 0, 5, P, 'lo'));
  for (const x of [-132, 126]) {
    base.push(slab(x, -58, 6, 116, 0, 7, P, 'mid'));
    for (const y of [-46, 46]) base.push(bolt(x + 3, y, 7, P));
  }
  const route = [];
  // Five capped rail lengths make the source -> build -> two dependent bays -> result fork legible.
  for (const [a, b] of [
    [[-126, 0], [-68, 0]], [[-68, 0], [14, -38]], [[-68, 0], [14, 38]],
    [[14, -38], [94, 0]], [[14, 38], [94, 0]], [[94, 0], [125, 0]],
  ]) route.push(bar(a, b, 6, .8, 3.2, P, 'mid'));
  for (const [x, y] of [[-68, 0], [14, -38], [14, 38], [94, 0]]) {
    route.push(solid(k.cylinder(x, y, 5, 4, 2, P, 16), 'mid'));
    route.push(solid(k.cylinder(x, y, 2, 6, 1, P, 16), 'hi'));
  }
  // Four guide wheels and two switch tongues belong to the fork, not to decoration.
  for (const [x, y] of [[-48, -12], [-48, 12], [55, -18], [55, 18]])
    route.push(solid(k.cylinder(x, y, 3.2, 4, 2, P, 16), 'lo'));
  route.push(bar([-69, -2], [-52, -10], 2.3, 6, 1, P, 'hi'));
  route.push(bar([-69, 2], [-52, 10], 2.3, 6, 1, P, 'hi'));

  const source = [];
  const cassette = { x: -141, y: -13, w: 31, d: 26, r: 1 };
  source.push(solid(k.slabOf(cassette, 6, 5, P, 3, .5), 'hi'));
  source.push(solid(k.slabOf(k.insetPlan(cassette, 4), 11, 7, P, 3, .6), 'mid'));
  source.push(solid(k.slabOf({ x: -132, y: -6, w: 13, d: 12, r: 1 }, 18, 2, P, 3), 'hi'));
  for (const x of [-136, -115]) for (const y of [-8, 8]) source.push(bolt(x, y, 11, P));
  source.push(slab(-146, -17, 6, 34, 0, 5, P, 'mid'));
  source.push(slab(-111, -17, 5, 34, 0, 5, P, 'mid'));

  const depends = [];
  // A central build module feeds two container-step bays in this illustrative DAG.
  function bay(cx, cy, wide = false) {
    const w = wide ? 38 : 36, d = 25;
    const b = { x: cx - w / 2, y: cy - d / 2, w, d, r: 1 };
    depends.push(solid(k.slabOf(b, 6, 5, P, 3, .6), 'mid'));
    for (const x of [cx - w / 2 + 5, cx + w / 2 - 5])
      for (const y of [cy - d / 2 + 5, cy + d / 2 - 5]) depends.push(solid(k.cylinder(x, y, 2.2, 11, 15, P, 14), 'lo'));
    depends.push(solid(k.slabOf({ x: cx - w / 2 - 2, y: cy - d / 2 - 2, w: w + 4, d: d + 4, r: 1 }, 26, 8, P, 3, .6), 'hi'));
    depends.push(solid(k.slabOf({ x: cx - 8, y: cy - 7, w: 16, d: 14, r: 1 }, 34, 2, P, 3), 'mid'));
    depends.push(solid(k.cylinder(cx, cy, 3.6, 15, 11, P, 18), 'mid'));
    depends.push(solid(k.cylinder(cx, cy, 5, 13, 2, P, 18), 'lo'));
    depends.push(slab(cx - 12, cy + d / 2 + 2, 24, 4, 6, 3, P, 'lo'));
    for (const x of [cx - w / 2 + 5, cx + w / 2 - 5]) depends.push(bolt(x, cy + d / 2 - 5, 34, P));
  }
  bay(-68, 0, true); bay(13, -41); bay(13, 41);
  // Side fences and capped rail ends make the two branches visually specific.
  for (const y of [-47, 47]) {
    depends.push(slab(43, y - 2, 13, 4, 0, 8, P, 'mid'));
    depends.push(bolt(49, y, 8, P));
  }

  const output = [];
  const drawer = { x: 94, y: -17, w: 43, d: 34, r: 1 };
  output.push(solid(k.slabOf(drawer, 5, 7, P, 3, .5), 'hi'));
  output.push(solid(k.slabOf(k.insetPlan(drawer, 5), 12, 2, P, 3), 'mid'));
  output.push(slab(101, 18, 29, 4, 6, 7, P, 'mid'));
  output.push(solid(k.cylinder(116, 20, 2.5, 9, 2, P, 16), 'hi'));
  for (const x of [100, 131]) for (const y of [-12, 12]) output.push(bolt(x, y, 12, P));
  output.push(slab(90, -21, 4, 42, 0, 7, P, 'lo'));
  output.push(slab(137, -21, 4, 42, 0, 7, P, 'lo'));

  // This is a movable selection index on a real front rail, not a run-status carrier.
  const indexRail = slab(-126, 67, 252, 3, 0, 2, P, 'lo');
  const ticks = k.topTicks(-120, 120, 8, 5, 69, 2, [2, 3.5], P);
  const index = k.groupSvg([
    solid(k.slabOf({ x: -125, y: 63, w: 18, d: 11, r: 1 }, 2, 4, P, 3), 'hi'),
    solid(k.slabOf({ x: -120, y: 65, w: 8, d: 7, r: 1 }, 6, 2, P, 3), 'mid'),
  ], { id: 'pipeline-index' });
  const body = [...base, group('depends', route), group('source', source), group('depends', depends), group('output', output),
    indexRail, line(ticks.minor, 'faint'), line(ticks.major, 'lo'), index].join('');
  const description = 'Isometric routing table: a Git source cassette feeds a build step, then two container-step bays whose declared dependencies permit parallel work. A drawer represents a declared artifact reference. The selected index illustrates parts, not a live run.';
  return {
    filename: 'pipeline.html', title: 'Pipeline dependencies', figure: 'FIG. 01 / PIPELINE',
    hint: 'Select a mechanism', W, H, P, body, description,
    steps: [
      { key: 'source', label: 'Git source', readout: '01 / SOURCE', detail: 'A Pipeline can check out a Git source before its container steps run.', index: [0, 0, 0] },
      { key: 'depends', label: 'Dependencies', readout: '02 / DEPENDS', detail: 'In this example, two container steps depend on build. Eligible steps can run in parallel, up to maxParallel.', index: [105, 0, 0] },
      { key: 'output', label: 'Declared output', readout: '03 / OUTPUT', detail: 'An artifact is a declared oci:// or configmap:// reference; Paprika records the reference when configured.', index: [225, 0, 0] },
    ],
    caption: 'Illustrative Pipeline configuration. The fork is one possible dependency graph; no execution or artifact upload is shown.',
    legend: [{ mark: 'lit', label: 'Selected mechanism' }, { mark: 'raised', label: 'Container step bay' }],
  };
}

function promotionFigure() {
  const W = 510, H = 365;
  const floor = { x: -78, y: -52, w: 156, d: 110, r: 2 };
  const P = k.fitProjection([...k.boxCorners(floor, -16, 0), [-82, -54, 183], [82, 58, 183]], W, H,
    { pad: 16, azimuth: 42, elevation: 23 });
  const base = [`<path class="iso-halo" d="${k.haloOf(floor, -16, 8, P)}"/>`];
  for (const [x, y] of k.corners(floor, 12)) {
    base.push(solid(k.cylinder(x, y, 6, -16, 6, P, 16), 'lo'));
    base.push(solid(k.cylinder(x, y, 4.5, -10, 2, P, 16), 'mid'));
  }
  base.push(solid(k.slabOf(floor, -8, 8, P, 3, .8), 'mid'));
  base.push(line(k.planOutline(k.insetPlan(floor, 4), 0, P, 3), 'faint'));
  for (const [x, y] of k.corners(floor, 9)) base.push(bolt(x, y, 0, P));
  // An upright guide cage, not a horizontal row of stations.
  for (const x of [-43, 35]) {
    base.push(slab(x, 15, 8, 12, 0, 169, P, 'mid'));
    base.push(slab(x - 2, 13, 12, 16, 169, 6, P, 'hi'));
  }
  for (const z of [7, 175]) base.push(slab(-47, 13, 94, 17, z, 5, P, 'hi'));
  for (const x of [-39, 39]) {
    base.push(slab(x - 1.5, -18, 3, 31, 10, 157, P, 'lo'));
    for (const z of [12, 164]) base.push(solid(k.cylinder(x, 9, 4, z, 3, P, 16), 'mid'));
  }
  for (const z of [34, 143]) {
    // Split landing ledges leave a continuous central lift path.
    base.push(slab(-53, -32, 32, 42, z, 5, P, 'hi'));
    base.push(slab(21, -32, 32, 42, z, 5, P, 'hi'));
    base.push(slab(-21, 4, 42, 6, z, 5, P, 'lo'));
    for (const x of [-48, 47]) base.push(bolt(x, -25, z + 5, P));
  }
  // Two narrow stops sit at each landing and are distinct from the gate modules.
  for (const z of [39, 148]) for (const x of [-20, 17]) base.push(slab(x, -29, 3, 9, z, 5, P, 'lo'));

  const verification = [];
  verification.push(slab(-75, -14, 25, 33, 66, 7, P, 'mid'));
  verification.push(slab(-73, -12, 22, 29, 73, 31, P, 'hi'));
  verification.push(solid(k.cylinder(-62, 2, 9, 104, 4, P, 28), 'mid'));
  verification.push(solid(k.cylinder(-62, 2, 5, 108, 2, P, 24), 'hi'));
  verification.push(line(k.ring(-62, 2, 3, 110, P, 24), 'mid'));
  for (const y of [-8, 13]) {
    verification.push(solid(k.cylinder(-62, y, 2.4, 74, 4, P, 14), 'lo'));
    verification.push(bolt(-65, y, 104, P));
  }
  verification.push(slab(-53, -2, 9, 8, 82, 5, P, 'mid'));
  verification.push(slab(-52, -2, 3, 8, 78, 18, P, 'lo'));

  const approval = [];
  // Bolted-on side latch is visibly optional, unlike the permanent lift guides.
  approval.push(slab(51, -15, 27, 32, 80, 7, P, 'mid'));
  approval.push(slab(53, -13, 23, 28, 87, 30, P, 'hi'));
  approval.push(solid(k.cylinder(65, 1, 8, 117, 4, P, 28), 'mid'));
  approval.push(solid(k.cylinder(65, 1, 4, 121, 2, P, 24), 'hi'));
  approval.push(line(k.ring(65, 1, 2.2, 123, P, 20), 'mid'));
  approval.push(slab(45, -3, 10, 8, 95, 5, P, 'mid'));
  approval.push(slab(43, -3, 3, 8, 90, 18, P, 'lo'));
  for (const y of [-9, 11]) for (const z of [88, 115]) approval.push(bolt(74, y, z, P));
  approval.push(line(k.coil(88, 103, [48, 5], 2.2, 6, 'z', P, 10), 'lo'));

  const carriage = [];
  carriage.push(slab(-23, -27, 46, 40, 40, 6, P, 'hi'));
  carriage.push(slab(-18, -22, 36, 30, 46, 9, P, 'mid'));
  carriage.push(slab(-13, -18, 26, 22, 55, 4, P, 'hi'));
  for (const x of [-27, 24]) for (const y of [-20, 6]) {
    carriage.push(solid(k.cylinder(x, y, 4, 41, 4, P, 16), 'lo'));
    carriage.push(solid(k.cylinder(x, y, 2.5, 45, 1, P, 16), 'hi'));
  }
  for (const x of [-15, 15]) carriage.push(bolt(x, -13, 59, P));
  // A cassette engraved only with one tiny symbolic mark; identity remains in the caption.
  carriage.push(k.faceTextSvg(k.topMatrix([0, -7], 59, P), 'SHA', { size: 5, tone: 'mid', anchor: 'middle' }));
  const lift = k.groupSvg(carriage, { id: 'promotion-lift', class: 'iso-assembly', 'data-assembly': 'next' });
  const body = [...base, group('verify', verification), group('approval', approval), lift].join('');
  const description = 'Isometric stage lift: separate Application landings are connected by a release cassette carrying one Git revision. A verification unit and optional manual-approval latch guard the previewed handoff; controls illustrate configured mechanisms and do not approve or deploy anything.';
  return {
    filename: 'gates.html', title: 'Staged promotion', figure: 'FIG. 02 / PROMOTION',
    hint: 'Inspect the handoff', W, H, P, body, description,
    steps: [
      { key: 'verify', label: 'Verification', readout: '01 / VERIFY', detail: 'A downstream Application can run configured tests; a stage can also use an HTTP smoke check or duration gate.' },
      { key: 'approval', label: 'Optional approval', readout: '02 / APPROVAL', detail: 'Manual approval is optional. When configured, it holds this candidate until an explicit approval action.' },
      { key: 'next', label: 'Preview handoff', readout: '03 / NEXT STAGE', detail: 'After required checks and approval clear, a separate Application can deploy the same pinned Git commit. This is only an illustration.' },
    ],
    caption: 'Configured example: separate Applications linked by spec.trigger.from. The handoff carries the Git revision; optional approval never happens from this figure.',
    legend: [{ mark: 'lit', label: 'Selected mechanism' }, { mark: 'raised', label: 'Release cassette' }],
  };
}

function buildPage(config) {
  const { filename, title, figure, hint, W, H, body, description, steps, caption, legend, P } = config;
  const svg = k.figureSvg({ width: W, height: H, label: description, body });
  const card = k.plateHtml({ fig: figure, title, hint, readout: steps[0].readout, keys: legend, caption, body: svg });
  const buttons = steps.map(({ label }, i) => `<button type="button" data-step="${i}" aria-pressed="${i === 0}">${escape(label)}</button>`).join('');
  const details = steps.map(({ key, label, readout, detail }) => ({ key, label, readout, detail }));
  const shifts = filename === 'pipeline.html' ? steps.map(({ index }) => k.axisVector(P, index)) : [];
  const liftShift = filename === 'gates.html' ? k.axisVector(P, [0, 0, 108]) : [];
  const js = `(() => {
    const details=${JSON.stringify(details)};
    const buttons=[...document.querySelectorAll('[data-step]')];
    const svg=document.querySelector('.iso-svg');
    const assemblies=[...svg.querySelectorAll('[data-assembly]')];
    const readout=document.querySelector('[data-readout]');
    const description=document.querySelector('#mechanism-description');
    const index=document.querySelector('#pipeline-index');
    const shifts=${JSON.stringify(shifts)};
    const lift=document.querySelector('#promotion-lift');
    const liftShift=${JSON.stringify(liftShift)};
    function select(i, focus=false) {
      const item=details[i];
      buttons.forEach((button,n)=>button.setAttribute('aria-pressed',String(n===i)));
      assemblies.forEach(node=>node.setAttribute('data-on',String(node.dataset.assembly===item.key)));
      if (index) index.setAttribute('transform','translate('+shifts[i][0]+' '+shifts[i][1]+')');
      if (lift) lift.setAttribute('transform',i===2?'translate('+liftShift[0]+' '+liftShift[1]+')':'translate(0 0)');
      readout.textContent=item.readout;
      description.textContent=item.detail;
      if (focus) buttons[i].focus();
    }
    buttons.forEach((button,i)=>{
      button.addEventListener('click',()=>select(i));
      button.addEventListener('keydown',event=>{
        const n={ArrowRight:(i+1)%buttons.length,ArrowDown:(i+1)%buttons.length,ArrowLeft:(i-1+buttons.length)%buttons.length,ArrowUp:(i-1+buttons.length)%buttons.length,Home:0,End:buttons.length-1}[event.key];
        if(n===undefined)return;
        event.preventDefault();select(n,true);
      });
    });
    select(0);
  })();`;
  const css = `${k.ISO_CSS}
    *{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:transparent;color:#1d1f20;font:400 15px/1.45 Barlow,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    .iso{--anatomy-card:#fff;--anatomy-paper:#fff;--anatomy-face:#fff;--anatomy-top:#f6f8f9;--anatomy-shade-0:#c3ccd4;--anatomy-shade-1:#d0d9e0;--anatomy-shade-2:#dee5ea;--anatomy-shade-3:#edf1f4;--anatomy-lit-top:#e5eff8;--anatomy-lit-shade:#c2d4e3;--anatomy-hi:#1d2d3d;--anatomy-mid:#597087;--anatomy-lo:#718595;--anatomy-faint:#c7d0d7;--anatomy-lit:#416180;--anatomy-halo:#8a9cab;--anatomy-halo-opacity:.18;--anatomy-dot:#1d2d3d;--anatomy-weight:.8px}
    .iso-figure{margin:0}.iso-plate{padding:36px 14px 28px;background:#fff;border:1px solid #c7d0d7;border-radius:0;box-shadow:none}.iso-plate-corners{inset:14px 16px}.iso-plate-corner{font-size:9px;letter-spacing:.08em;color:#597087}.iso-plate-corner[data-corner="fig"]{color:#1d2d3d}.iso-plate-corner[data-corner="title"]{font-family:"Barlow Condensed",Barlow,Arial,sans-serif;font-weight:700;font-size:11px;letter-spacing:.08em}.iso-plate-corner[data-corner="readout"]{color:#416180}.iso-svg{overflow:hidden}
    .iso-assembly .iso-shade,.iso-assembly .iso-top,.iso-assembly .iso-edge{transition:fill .24s ease,stroke .24s ease}.iso-assembly[data-on="true"] .iso-top{fill:#e5eff8}.iso-assembly[data-on="true"] .iso-shade[data-shade="0"]{fill:#a8bfd1}.iso-assembly[data-on="true"] .iso-shade[data-shade="1"]{fill:#bad0df}.iso-assembly[data-on="true"] .iso-shade[data-shade="2"]{fill:#cedfeb}.iso-assembly[data-on="true"] .iso-shade[data-shade="3"]{fill:#e2edf5}.iso-assembly[data-on="true"] .iso-edge{stroke:#416180}#pipeline-index,#promotion-lift{transition:transform .65s cubic-bezier(.2,.7,.2,1)}
    .iso-legend{display:grid;gap:5px;margin:8px 2px 0;font-size:12px;line-height:1.45;color:#56616b}.iso-key{gap:5px}.controls{display:flex;gap:0;margin:12px 0 0;border:1px solid #aebbc6}.controls button{flex:1;min-width:0;min-height:42px;padding:8px 7px;border:0;border-right:1px solid #aebbc6;border-radius:0;background:#fff;color:#1d2d3d;font:600 12px/1.2 Barlow,Arial,sans-serif;cursor:pointer}.controls button:last-child{border-right:0}.controls button:hover{background:#f2f5f7}.controls button[aria-pressed="true"]{background:#dce8f1;color:#244562;box-shadow:inset 0 -3px 0 #5980a6}.controls button:focus-visible{outline:3px solid #416180;outline-offset:-4px;position:relative;z-index:1}#mechanism-description{min-height:2.8em;margin:10px 2px 0;color:#3f4c56;font-size:13px;line-height:1.45}
    @media(max-width:520px){.iso-plate{padding:34px 4px 26px;overflow:hidden}.iso-plate-corners{inset:12px 10px}.iso-plate-corner[data-corner="title"]{display:none}.iso-svg{width:130%;max-width:none;margin-left:-15%}.controls button{font-size:11px}.iso-legend{font-size:11px}}
    @media(prefers-reduced-motion:reduce){#pipeline-index,#promotion-lift,.iso-assembly .iso-shade,.iso-assembly .iso-top,.iso-assembly .iso-edge{transition:none}.iso-line[data-flow],.iso-dots circle[data-pulse]{animation:none}}
  `;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Paprika</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600&family=Barlow+Condensed:wght@700&display=swap" rel="stylesheet"><style>${css}</style></head><body class="iso"><main>${card}<div class="controls" role="group" aria-label="Explore ${escape(title)}">${buttons}</div><p id="mechanism-description" role="status" aria-live="polite">${escape(steps[0].detail)}</p></main><script>${js}</script></body></html>`;
  writeFileSync(join(here, filename), html);
  console.log(`${filename}: ${Buffer.byteLength(html)} bytes`);
}

buildPage(pipelineFigure());
buildPage(promotionFigure());
