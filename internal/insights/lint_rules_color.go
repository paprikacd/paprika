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
		Fix:      "Name a status or a series role instead of this hex, or choose a hue further from the ok, warning and critical hues.",
		check:    checkNearStatusColor,
	},
}

// Status-like colour is judged on hue and chroma, not lightness. The critical marks are very dark in
// light and very pale in dark, so a lightness distance misses saturated reds and over-flags neutral
// blues and greys. Only the ok, warning and critical families count: info and unknown hues are never
// status-like. A colour is flagged when its CIELAB chroma reaches statusMinChroma and its hue lies within
// statusHueWindow degrees of a family mark in any theme. On the published marks the family hues sit near
// 150 (ok), 75 (warning) and 33 (critical); the blues sit near 250 and the greys have chroma under 10.
const (
	statusMinChroma = 12
	statusHueWindow = 30
)

// statusFamilies are the levels whose hue a bare authored colour must not echo.
var statusFamilies = map[string]bool{"ok": true, "warning": true, "critical": true}

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

// checkNearStatusColor fires for each authored hex on a field with no status or role that reads as a
// status hue (see statusHueWindow). The message names the nearest family mark and its theme.
func checkNearStatusColor(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, field := range widget.colorFields {
			mark, gap, chroma, ok := nearestStatusHue(field.hex)
			if !ok || gap > statusHueWindow {
				continue
			}
			hits = append(hits, lintHit{
				pointer:  field.pointer,
				widgetID: widget.id,
				message: fmt.Sprintf("%s %s %s has hue %s degrees from the %s status in the %s theme (chroma %s); name a status or series role, or use a hue further from the ok, warning and critical hues",
					widgetLabel(widget), field.what, field.hex, strconv.FormatFloat(gap, 'f', 0, 64), mark.level, mark.theme, strconv.FormatFloat(chroma, 'f', 0, 64)),
			})
		}
	}
	return hits
}

// nearestStatusHue returns the family mark whose hue is closest to hex, the hue gap in degrees and the
// chroma of hex. ok is false for a malformed colour or one below statusMinChroma, which is too neutral to
// read as a status.
func nearestStatusHue(hex string) (mark statusMark, gap, chroma float64, ok bool) {

	rgb, valid := parseHexRGB(hex)
	if !valid {
		return statusMark{}, 0, 0, false
	}
	colour := srgbToLab(rgb)
	chroma = math.Hypot(colour.a, colour.b)
	if chroma < statusMinChroma {
		return statusMark{}, 0, chroma, false
	}
	hue := hueDegrees(colour)
	gap = math.Inf(1)
	for _, candidate := range statusMarks {
		if !statusFamilies[candidate.level] {
			continue
		}
		markRGB, _ := parseHexRGB(candidate.hex)
		if d := hueGap(hue, hueDegrees(srgbToLab(markRGB))); d < gap {
			mark, gap = candidate, d
		}
	}
	return mark, gap, chroma, true
}

// hueDegrees is the CIELAB hue angle, from 0 to 360.
func hueDegrees(c lab) float64 {
	h := math.Atan2(c.b, c.a) * 180 / math.Pi
	if h < 0 {
		h += 360
	}
	return h
}

// hueGap is the shorter angular distance between two hue angles, from 0 to 180.
func hueGap(a, b float64) float64 {
	d := math.Abs(a - b)
	return math.Min(d, 360-d)
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
