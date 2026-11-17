"""Measure authored line geometry from the supplied concept PNGs.

Outputs vector fixture profiles, never an image used as the rendered dashboard.
Occluded runs are deterministic reconstructions, not recovered measurements.
"""
from pathlib import Path
import json
import math
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

def profile(image, bounds, colour, omit, seed):
    a = np.asarray(Image.open(image).convert('RGB')).astype(float)
    left, top, right, bottom = bounds
    xs = np.linspace(left, right, 361)
    ys = []
    for x in xs:
        if any(lo <= x <= hi for lo, hi in omit):
            ys.append(None)
            continue
        pixels = a[top:bottom, round(x)]
        r,g,b = pixels.T
        if colour == 'cyan': mask = (r < 125) & (g > 125) & (b > 165) & (b > r*1.6)
        else: mask = (r > 90) & (b > 135) & (b > g*1.3) & (b > r*1.12)
        hits = np.flatnonzero(mask)
        if len(hits):
            score = (g+b-r if colour == 'cyan' else r+b-g)[hits]
            peak = hits[np.argmax(score)]
            ys.append(float(top+peak))
        else: ys.append(None)
    known = [i for i,y in enumerate(ys) if y is not None]
    for i,y in enumerate(ys):
        if y is None:
            before=max((j for j in known if j<i),default=known[0]); after=min((j for j in known if j>i),default=known[-1])
            t=(i-before)/max(1,after-before)
            base=ys[before]*(1-t)+ys[after]*t
            wave=math.sin(i*2.31+seed)*3.5+math.sin(i*.78+seed)*4
            ys[i]=base+wave*math.sin(math.pi*t)
    return [round(y,2) for y in ys]

edge=ROOT/'docs/reference/edge-watch.png'
reliability=ROOT/'docs/reference/reliability-room.png'
data={
 'edgeIngressProfile':profile(edge,(154,280,1027,388),'cyan',[(638,650),(710,965)],1),
 'edgeEgressProfile':profile(edge,(154,392,1027,468),'violet',[(638,650),(710,965)],7),
 'burnOneHourProfile':profile(reliability,(143,331,1001,497),'cyan',[(555,568),(596,822),(833,921)],2),
 'burnSixHourProfile':profile(reliability,(143,408,1001,503),'violet',[(555,568),(596,822),(833,921)],4),
}
out='// Authored concept geometry. Generated with scripts/trace-reference-profiles.py.\n'
out+='// Hidden portions are deterministic reconstruction, not observed telemetry.\n'
for key,value in data.items(): out+=f'export const {key}: readonly number[] = '+json.dumps(value,separators=(',',':'))+';\n'
(ROOT/'src/reference/reference-profiles.ts').write_text(out)
print('Wrote four 361-point reference profiles')
