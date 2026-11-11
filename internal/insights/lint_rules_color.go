package insights

import (
	"fmt"
	"math"
	"strconv"
)

// guidanceStatusColour is the composition line the color rule maps to.
const guidanceStatusColour = "Name a status for a threshold and a series role for a series colour. A hex colour is an override only where it has its own meaning, and it must not look like a status colour."

var colorLintRules = []lintRule{
	{
		ID:       "color.near-status",
		Severity: warningSeverity,
		Summary:  guidanceStatusColour,
		Fix:      "Name a status or a series role instead of this hex, or choose a hue at least 10 dE2000 away from every status colour in each theme.",
		check:    checkNearStatusColor,
	},
}

// nearStatusDeltaE is the CIEDE2000 distance below which an authored hex reads as a status colour.
const nearStatusDeltaE = 10

// statusMark is one status colour in one theme: the --gamma-status-<level> mark that paints thresholds.
type statusMark struct {
	level, theme, hex string
}

// statusMarks mirrors the mark tokens in docs/design/insights/status-tokens.json. The
// lint_rules_color_test.go test fails when these values drift from that file.
var statusMarks = []statusMark{
	{"ok", "light", "#4b9864"}, {"info", "light", "#3f72b4"}, {"warning", "light", "#986111"}, {"critical", "light", "#7f0a12"}, {"unknown", "light", "#4d5d68"},
	{"ok", "dark", "#498a5c"}, {"info", "dark", "#5b93d6"}, {"warning", "dark", "#cb9742"}, {"critical", "dark", "#ffd4cc"}, {"unknown", "dark", "#aab7bf"},
	{"ok", "compact", "#3e8357"}, {"info", "compact", "#6aa9ee"}, {"warning", "compact", "#d0993c"}, {"critical", "compact", "#ffc6bc"}, {"unknown", "compact", "#8a9ca6"},
}

// colorField is one authored hex that carries no status or role. what names the field for the message.
type colorField struct {
	pointer string
	what    string
	hex     string
}

// checkNearStatusColor fires for each authored hex on a field with no status or
// role that is within nearStatusDeltaE of a status mark in any theme. The
// nearest mark is named, so an author knows which status the hue would read as.
func checkNearStatusColor(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, field := range widget.colorFields {
			mark, distance, ok := nearestStatusMark(field.hex)
			if !ok || distance >= nearStatusDeltaE {
				continue
			}
			hits = append(hits, lintHit{
				pointer:  field.pointer,
				widgetID: widget.id,
				message: fmt.Sprintf("%s %s is %s dE2000 from the %s status colour in the %s theme; name a status or series role, or use a hue further from status colours",
					widgetLabel(widget), field.what, strconv.FormatFloat(distance, 'f', 1, 64), mark.level, mark.theme),
			})
		}
	}
	return hits
}

// nearestStatusMark returns the status mark closest to hex, and its CIEDE2000 distance.
// ok is false when hex is not a six-digit colour.
func nearestStatusMark(hex string) (statusMark, float64, bool) {
	rgb, ok := parseHexRGB(hex)
	if !ok {
		return statusMark{}, 0, false
	}
	lab := srgbToLab(rgb)
	best, bestDistance := statusMark{}, math.Inf(1)
	for _, mark := range statusMarks {
		markRGB, _ := parseHexRGB(mark.hex)
		if d := deltaE2000(lab, srgbToLab(markRGB)); d < bestDistance {
			best, bestDistance = mark, d
		}
	}
	return best, bestDistance, true
}

// parseHexRGB reads a six-digit #rrggbb colour into channels from 0 to 255.
func parseHexRGB(hex string) ([3]float64, bool) {
	if len(hex) != 7 || hex[0] != '#' {
		return [3]float64{}, false
	}
	var out [3]float64
	for c := range 3 {
		value, err := strconv.ParseUint(hex[1+2*c:3+2*c], 16, 8)
		if err != nil {
			return [3]float64{}, false
		}
		out[c] = float64(value)
	}
	return out, true
}

// lab is a CIE L*a*b* colour under the D65 white.
type lab struct{ l, a, b float64 }

// srgbToLab converts sRGB channels (0 to 255) to CIE L*a*b* with the D65 white point.
func srgbToLab(rgb [3]float64) lab {
	linear := func(channel float64) float64 {
		c := channel / 255
		if c <= 0.04045 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	r, g, b := linear(rgb[0]), linear(rgb[1]), linear(rgb[2])
	x := (0.4124564*r + 0.3575761*g + 0.1804375*b) / 0.95047
	y := 0.2126729*r + 0.7151522*g + 0.0721750*b
	z := (0.0193339*r + 0.1191920*g + 0.9503041*b) / 1.08883
	f := func(t float64) float64 {
		if t > 216.0/24389.0 {
			return math.Cbrt(t)
		}
		return (24389.0/27.0*t + 16) / 116
	}
	fx, fy, fz := f(x), f(y), f(z)
	return lab{l: 116*fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz)}
}

func square(x float64) float64 { return x * x }

// meanHue is the mean hue angle of two colours, taking the short way round the circle.
// A colour with zero chroma has no hue, so the sum is returned unchanged.
func meanHue(h1p, h2p float64, chromatic bool) float64 {
	switch {
	case !chromatic:
		return h1p + h2p
	case math.Abs(h1p-h2p) <= 180:
		return (h1p + h2p) / 2
	case h1p+h2p < 360:
		return (h1p + h2p + 360) / 2
	default:
		return (h1p + h2p - 360) / 2
	}
}

// deltaE2000 is the CIEDE2000 colour difference with unit weights (kL = kC = kH = 1).
// It follows Sharma, Wu and Dalal (2005), including the hue-angle wrap rules.
func deltaE2000(p, q lab) float64 {
	radians := func(deg float64) float64 { return deg * math.Pi / 180 }
	degrees := func(rad float64) float64 { return rad * 180 / math.Pi }
	hueAngle := func(b, a float64) float64 {
		if a == 0 && b == 0 {
			return 0
		}
		h := degrees(math.Atan2(b, a))
		if h < 0 {
			h += 360
		}
		return h
	}
	c1, c2 := math.Hypot(p.a, p.b), math.Hypot(q.a, q.b)
	cBar := (c1 + c2) / 2
	pow7 := math.Pow(cBar, 7)
	g := 0.5 * (1 - math.Sqrt(pow7/(pow7+math.Pow(25, 7))))
	a1p, a2p := (1+g)*p.a, (1+g)*q.a
	c1p, c2p := math.Hypot(a1p, p.b), math.Hypot(a2p, q.b)
	h1p, h2p := hueAngle(p.b, a1p), hueAngle(q.b, a2p)
	dLp := q.l - p.l
	dCp := c2p - c1p
	dhp := 0.0
	if c1p*c2p != 0 {
		dhp = h2p - h1p
		if dhp > 180 {
			dhp -= 360
		} else if dhp < -180 {
			dhp += 360
		}
	}
	dHp := 2 * math.Sqrt(c1p*c2p) * math.Sin(radians(dhp/2))
	lBarP := (p.l + q.l) / 2
	cBarP := (c1p + c2p) / 2
	hBarP := meanHue(h1p, h2p, c1p*c2p != 0)
	t := 1 - 0.17*math.Cos(radians(hBarP-30)) + 0.24*math.Cos(radians(2*hBarP)) +
		0.32*math.Cos(radians(3*hBarP+6)) - 0.20*math.Cos(radians(4*hBarP-63))
	dTheta := 30 * math.Exp(-square((hBarP-275)/25))
	cBarP7 := math.Pow(cBarP, 7)
	rC := 2 * math.Sqrt(cBarP7/(cBarP7+math.Pow(25, 7)))
	sL := 1 + 0.015*square(lBarP-50)/math.Sqrt(20+square(lBarP-50))
	sC := 1 + 0.045*cBarP
	sH := 1 + 0.015*cBarP*t
	rT := -math.Sin(radians(2*dTheta)) * rC
	termL, termC, termH := dLp/sL, dCp/sC, dHp/sH
	return math.Sqrt(termL*termL + termC*termC + termH*termH + rT*termC*termH)
}
