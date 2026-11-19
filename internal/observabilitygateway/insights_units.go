package observabilitygateway

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Agent text follows the UI's unit rule (ui/src/features/insights/units.ts): a value with a scalable unit picks one
// step first, from its own magnitude, and the widget's decimals (or Auto's three significant figures) apply to the
// scaled number. "296303060975000 bytes" reads "269.486 TiB" at three decimals and "269 TiB" in Auto.

type dashboardUnitStep struct {
	prefix string
	unit   string
	factor float64
}

var (
	dashboardByteUnits   = []string{"B", "KiB", "MiB", "GiB", "TiB", "PiB"}
	dashboardSIPrefixes  = []string{"", "k", "M", "G", "T", "P"}
	dashboardCountPrefix = []string{"", "K", "M", "B", "T"}
	dashboardCountNouns  = map[string]bool{"req": true, "requests": true, "obs": true, "observations": true, "ops": true, "operations": true, "events": true, "msgs": true, "messages": true, "queries": true, "samples": true, "hits": true, "errors": true, "calls": true, "writes": true, "reads": true, "items": true, "rows": true, "spans": true, "traces": true, "logs": true, "connections": true, "packets": true}
	dashboardBitsUnit    = regexp.MustCompile(`^([kKMGTP]?)(bit|b)/s$`)
	dashboardRateUnit    = regexp.MustCompile(`^([^/]*)/s$`)
)

// dashboardUnitSteps mirrors unitsFor for readings (never the compact axis form): the authored unit is the index.
func dashboardUnitSteps(unit string) (steps []dashboardUnitStep, index int) {
	for _, family := range []func(string) ([]dashboardUnitStep, int, bool){dashboardBinarySteps, dashboardDurationSteps, dashboardBitSteps, dashboardCountRateSteps} {
		if steps, index, ok := family(unit); ok {
			return steps, index
		}
	}
	return []dashboardUnitStep{{unit: unit, factor: 1}}, 0
}

// dashboardBinarySteps covers IEC bytes and bytes per second: 1024 per step.
func dashboardBinarySteps(unit string) ([]dashboardUnitStep, int, bool) {
	perSecond := unit == "B/s"
	bytesUnit := unit
	if unit == "bytes" {
		bytesUnit = "B"
	}
	index := slices.Index(dashboardByteUnits, bytesUnit)
	if !perSecond && index < 0 {
		return nil, 0, false
	}
	steps := make([]dashboardUnitStep, len(dashboardByteUnits))
	for i, name := range dashboardByteUnits {
		if perSecond {
			name += "/s"
			index = 0
		}
		steps[i] = dashboardUnitStep{unit: name, factor: math.Pow(1024, float64(i))}
	}
	return steps, index, true
}

// dashboardDurationSteps covers ns, us (and µs), ms and s.
func dashboardDurationSteps(unit string) ([]dashboardUnitStep, int, bool) {
	name := unit
	if unit == "µs" || unit == "μs" {
		name = "us"
	}
	durations := []dashboardUnitStep{{unit: "ns", factor: 1e-9}, {unit: "us", factor: 1e-6}, {unit: "ms", factor: 1e-3}, {unit: "s", factor: 1}}
	index := slices.IndexFunc(durations, func(step dashboardUnitStep) bool { return step.unit == name })
	return durations, index, index >= 0
}

// dashboardBitSteps covers SI bit and byte rates such as kbit/s and Mb/s: 1000 per step.
func dashboardBitSteps(unit string) ([]dashboardUnitStep, int, bool) {
	bits := dashboardBitsUnit.FindStringSubmatch(unit)
	if bits == nil {
		return nil, 0, false
	}
	prefix := bits[1]
	if prefix == "K" {
		prefix = "k"
	}
	steps := make([]dashboardUnitStep, len(dashboardSIPrefixes))
	for i, name := range dashboardSIPrefixes {
		steps[i] = dashboardUnitStep{unit: name + bits[2] + "/s", factor: math.Pow(1000, float64(i))}
	}
	return steps, slices.Index(dashboardSIPrefixes, prefix), true
}

// dashboardCountRateSteps covers per-second rates of counting nouns (req/s), which take a K, M, B or T prefix.
func dashboardCountRateSteps(unit string) ([]dashboardUnitStep, int, bool) {
	rate := dashboardRateUnit.FindStringSubmatch(unit)
	if rate == nil || (rate[1] != "" && !dashboardCountNouns[rate[1]]) {
		return nil, 0, false
	}
	name := "/s"
	if rate[1] != "" {
		name = rate[1] + "/s"
	}
	steps := make([]dashboardUnitStep, len(dashboardCountPrefix))
	for i, prefix := range dashboardCountPrefix {
		steps[i] = dashboardUnitStep{prefix: prefix, unit: name, factor: math.Pow(1000, float64(i))}
	}
	return steps, 0, true
}

// dashboardRoundSig rounds to n significant digits, half up on the shortest decimal that round-trips the value, as the
// UI's Intl formatting does: 0.9995 rounds to 1, not 0.999 (its binary value sits just below the decimal).
func dashboardRoundSig(value float64, digits int) float64 {
	if value == 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return value
	}
	sign := 1.0
	if value < 0 {
		sign, value = -1, -value
	}
	mantissa, exponentText, _ := strings.Cut(strconv.FormatFloat(value, 'e', -1, 64), "e")
	exponent, err := strconv.Atoi(exponentText)
	if err != nil {
		return sign * value
	}
	number := strings.Replace(mantissa, ".", "", 1)
	if len(number) > digits {
		head := number[:digits]
		if number[digits] >= '5' {
			head = dashboardIncrement(head)
			if len(head) > digits {
				head = head[:digits]
				exponent++
			}
		}
		number = head
	}
	rounded, err := strconv.ParseFloat(number[:1]+"."+number[1:]+"e"+strconv.Itoa(exponent), 64)
	if err != nil {
		return sign * value
	}
	return sign * rounded
}

// dashboardIncrement adds one to a string of decimal digits.
func dashboardIncrement(digits string) string {
	bytes := []byte(digits)
	for i := len(bytes) - 1; i >= 0; i-- {
		if bytes[i] < '9' {
			bytes[i]++
			return string(bytes)
		}
		bytes[i] = '0'
	}
	return "1" + string(bytes)
}

// dashboardGroup adds a thousands separator between every three integer digits.
func dashboardGroup(whole string) string {
	var out strings.Builder
	for i, digit := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteRune(digit)
	}
	return out.String()
}

// dashboardFixed writes a value with exactly places fraction digits, half up on its shortest decimal, with thousands
// separators in the whole part. Zero never takes a sign.
func dashboardFixed(value float64, places int) string {
	negative := value < 0
	whole, fraction, _ := strings.Cut(strconv.FormatFloat(math.Abs(value), 'f', -1, 64), ".")
	digits := whole + fraction + strings.Repeat("0", max(0, places-len(fraction)))
	cut := len(whole)
	if len(fraction) > places {
		kept := whole + fraction[:places]
		if fraction[places] >= '5' {
			kept = dashboardIncrement(kept)
		}
		digits = kept
		cut = len(kept) - places
	} else {
		digits = digits[:cut+places]
	}
	wholePart, fractionPart := digits[:cut], digits[cut:]
	if strings.Trim(digits, "0") == "" {
		negative = false
	}
	text := dashboardGroup(wholePart)
	if places > 0 {
		text += "." + fractionPart
	}
	if negative {
		return "-" + text
	}
	return text
}

// dashboardInStep expresses a value authored in steps[index] in steps[candidate].
func dashboardInStep(value float64, steps []dashboardUnitStep, index, candidate int) float64 {
	if candidate == index {
		return value
	}
	return dashboardRoundSig((value*steps[index].factor)/steps[candidate].factor, 12)
}

// dashboardChooseStep is the largest step whose three-figure value reads at least one of that step's unit.
func dashboardChooseStep(steps []dashboardUnitStep, index int, value float64) int {
	if value == 0 {
		return index
	}
	for candidate := len(steps) - 1; candidate > 0; candidate-- {
		if dashboardRoundSig(math.Abs(dashboardInStep(value, steps, index, candidate)), 3) >= 1 {
			return candidate
		}
	}
	return 0
}

// dashboardExponent writes a value in exponent form with the leading zero of the exponent dropped, as the UI does
// ("1e-7", not "1e-07").
func dashboardExponent(value float64) string {
	return dashboardTrimExponent(strconv.FormatFloat(value, 'e', -1, 64))
}

// dashboardTrimExponent drops the leading zeros of an exponent in formatted text ("1e-07" becomes "1e-7").
func dashboardTrimExponent(text string) string {
	mantissa, exponent, found := strings.Cut(text, "e")
	if !found || len(exponent) < 2 {
		return text
	}
	return mantissa + "e" + exponent[:1] + strings.TrimLeft(exponent[1:], "0")
}

// dashboardAutoNumber is the reading precision of a scaled value: three significant figures, at most two fraction
// digits from one upwards, and an exponent only where the value is outside the plain range.
func dashboardAutoNumber(value float64) string {
	magnitude := math.Abs(value)
	if magnitude >= 1e15 || (magnitude > 0 && magnitude < 1e-6) {
		return dashboardExponent(dashboardRoundSig(value, 3))
	}
	rounded := dashboardRoundSig(magnitude, 3)
	places := 0
	if rounded > 0 {
		places = max(0, 2-int(math.Floor(math.Log10(rounded)+1e-12)))
	}
	if magnitude >= 1 {
		places = min(2, places)
	}
	text := dashboardFixed(value, places)
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	return text
}

// dashboardSpecialReading covers values that take no unit scaling: non-finite values, and percent in Auto.
func dashboardSpecialReading(value float64, unit string, decimals *int) (string, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return dashboardNumberText(value), true
	}
	if unit == "%" && decimals == nil {
		return dashboardPercentAuto(value), true
	}
	return "", false
}

// dashboardReading formats a value for text in its unit family. The unit is chosen first, then the widget's decimals
// (or Auto) apply to the scaled number. It returns the number, with any count or SI prefix attached, and the display
// unit, which is the authored unit when nothing scaled. A unit-less count stays whole ("84", never "84.000").
func dashboardReading(value float64, unit string, decimals *int) (number, displayUnit string) {
	if text, ok := dashboardSpecialReading(value, unit, decimals); ok {
		return text, unit
	}
	steps, index := dashboardUnitSteps(unit)
	candidate := index
	if decimals != nil || unit != "" {
		candidate = dashboardChooseStep(steps, index, value)
	}
	displayUnit = steps[candidate].unit
	if candidate == index {
		displayUnit = unit
	}
	if unit == "" && candidate == index && (decimals == nil || value == math.Trunc(value)) {
		return dashboardNumberText(value), unit
	}
	return dashboardScaledNumber(dashboardInStep(value, steps, index, candidate), steps[candidate].prefix, decimals), displayUnit
}

// dashboardPercentAuto is the UI's percent rule in Auto: two places from one upwards (three significant figures below
// one), extra places while the value would round to 100, and the exact shortest form when no place count avoids it.
// A value below 100 never reads as 100, and 100 is shown only for exactly 100.
func dashboardPercentAuto(value float64) string {
	magnitude := math.Abs(value)
	places := 2
	if magnitude < 1 {
		places = 0
		if rounded := dashboardRoundSig(magnitude, 3); rounded > 0 {
			places = max(0, 2-int(math.Floor(math.Log10(rounded)+1e-12)))
		}
	}
	showsHundred := func(places int) bool {
		text := strings.ReplaceAll(dashboardFixed(value, places), ",", "")
		if strings.Contains(text, ".") {
			text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
		}
		return (text == "100" || text == "-100") && magnitude != 100
	}
	for places < 8 && showsHundred(places) {
		places++
	}
	if showsHundred(places) {
		_, fraction, _ := strings.Cut(strconv.FormatFloat(value, 'f', -1, 64), ".")
		return dashboardFixed(value, len(fraction))
	}
	text := dashboardFixed(value, places)
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	return text
}

// dashboardScaledNumber writes a value already in its display unit: at the widget's decimals, or in Auto.
func dashboardScaledNumber(scaled float64, prefix string, decimals *int) string {
	if scaled == 0 {
		prefix = ""
	}
	if decimals != nil {
		return dashboardFixed(scaled, min(max(*decimals, 0), 8)) + prefix
	}
	return dashboardAutoNumber(scaled) + prefix
}

// dashboardReadingWithUnit is the reading as one phrase: "269.486 TiB", "18%", "84".
func dashboardReadingWithUnit(value float64, unit string, decimals *int) string {
	number, displayUnit := dashboardReading(value, unit, decimals)
	if displayUnit == "%" {
		return number + "%"
	}
	if displayUnit == "" {
		return number
	}
	return number + " " + displayUnit
}
