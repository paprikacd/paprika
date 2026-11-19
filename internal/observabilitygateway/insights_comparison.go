package observabilitygateway

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The insights backend reports a stat's change with its exact sign. The change is read the way the UI reads it: a change
// that rounds to nothing at the widget's display (or is float noise in Auto) is "≈0", with no direction and no assessment.
// The display rules live here, beside the reading formatter, so the structured output and the text agree with the UI.

// comparisonNumber is the leading number of a formatted reading, as a JavaScript parseFloat reads it.
var comparisonNumber = regexp.MustCompile(`^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`)

// comparisonDisplay is the part of a comparison the display rules need.
type comparisonDisplay struct {
	State      string   `json:"state"`
	Delta      *float64 `json:"delta"`
	Percent    *float64 `json:"percent"`
	ChangeUnit string   `json:"changeUnit"`
	Direction  string   `json:"direction"`
	Assessment *string  `json:"assessment"`
	Current    *struct {
		Value float64 `json:"value"`
	} `json:"current"`
}

// comparisonWidget is a widget's unit, decimals and comparison, as the display rules read them.
type comparisonWidget struct {
	Unit       string             `json:"unit"`
	Decimals   *int               `json:"decimals"`
	Comparison *comparisonDisplay `json:"comparison"`
}

// settleDashboardComparisons rewrites each stat's comparison direction and assessment to the UI's rule. Any other part of
// the body is kept as the backend wrote it. A body it cannot read is returned unchanged.
func settleDashboardComparisons(body json.RawMessage) json.RawMessage {
	var typed struct {
		Widgets []comparisonWidget `json:"widgets"`
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(body, &typed) != nil || json.Unmarshal(body, &document) != nil || len(typed.Widgets) == 0 {
		return body
	}
	var widgets []map[string]json.RawMessage
	if json.Unmarshal(document["widgets"], &widgets) != nil || len(widgets) != len(typed.Widgets) {
		return body
	}
	changed := false
	for index := range typed.Widgets {
		settled, ok := settleWidgetComparison(&typed.Widgets[index], widgets[index])
		if ok {
			widgets[index]["comparison"] = settled
			changed = true
		}
	}
	if !changed {
		return body
	}
	return reencodeWithWidgets(document, widgets, body)
}

// reencodeWithWidgets writes the settled widgets back into the body. A failure returns the original body.
func reencodeWithWidgets(document map[string]json.RawMessage, widgets []map[string]json.RawMessage, original json.RawMessage) json.RawMessage {
	encodedWidgets, err := json.Marshal(widgets)
	if err != nil {
		return original
	}
	document["widgets"] = encodedWidgets
	encoded, err := json.Marshal(document)
	if err != nil {
		return original
	}
	return encoded
}

// settleWidgetComparison returns the widget's comparison with its settled direction and assessment, and whether it changed.
// Only a stat's change in the ok or partial state, with a displayed sample, can settle.
func settleWidgetComparison(widget *comparisonWidget, raw map[string]json.RawMessage) (json.RawMessage, bool) {
	comparison := widget.Comparison
	if comparison == nil || (comparison.State != "ok" && comparison.State != "partial") || comparison.Delta == nil || comparison.Current == nil {
		return nil, false
	}
	if comparison.Direction == "flat" || !comparisonRoundsToNothing(*comparison.Delta, comparison.Percent, widget.Unit, widget.Decimals, comparison.Current.Value) {
		return nil, false
	}
	comparison.Direction = "flat"
	if comparison.Assessment != nil {
		unchanged := "unchanged"
		comparison.Assessment = &unchanged
	}
	settled, err := mergeComparison(raw["comparison"], comparison)
	return settled, err == nil
}

// mergeComparison writes the settled direction and assessment into the comparison object, keeping its other fields.
func mergeComparison(raw json.RawMessage, settled *comparisonDisplay) (json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("decode comparison fields: %w", err)
	}
	direction, err := json.Marshal(settled.Direction)
	if err != nil {
		return nil, fmt.Errorf("encode comparison direction: %w", err)
	}
	fields["direction"] = direction
	if settled.Assessment != nil {
		assessment, encodeErr := json.Marshal(*settled.Assessment)
		if encodeErr != nil {
			return nil, fmt.Errorf("encode comparison assessment: %w", encodeErr)
		}
		fields["assessment"] = assessment
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, fmt.Errorf("encode comparison: %w", err)
	}
	return encoded, nil
}

// comparisonRoundsToNothing mirrors the UI's formatChange: whether the change reads as "≈0" at the widget's display.
// A percentage widget reports percentage points, a change with a relative percent is read by that percent, and any other
// change is read in the widget unit.
func comparisonRoundsToNothing(delta float64, percent *float64, unit string, decimals *int, current float64) bool {
	if delta == 0 {
		return true
	}
	form, magnitude, measured := "absolute", delta, unit
	switch {
	case unit == "%":
		form, measured = "points", "pp"
	case percent != nil:
		form, magnitude, measured = "relative", *percent, "%"
	}
	if comparisonLeadingValue(dashboardReadingWithUnit(magnitude, measured, decimals)) == 0 {
		return true
	}
	return comparisonIsNoise(delta, form, percent, decimals, current)
}

// comparisonIsNoise mirrors the UI's isChangeNoise: explicit decimals decide their own rounding, a relative change is noise
// below 0.005%, and other changes are noise below the reading's precision (one part in two thousand of it).
func comparisonIsNoise(delta float64, form string, percent *float64, decimals *int, current float64) bool {
	if decimals != nil {
		return false
	}
	if form == "relative" && percent != nil {
		return math.Abs(*percent) < .005
	}
	reading := math.Abs(current)
	if reading > 0 {
		return math.Abs(delta) < reading*5e-4
	}
	return math.Abs(delta) < 1e-12
}

// comparisonLeadingValue reads a formatted reading's number. An unreadable reading is never zero.
func comparisonLeadingValue(text string) float64 {
	match := comparisonNumber.FindString(strings.ReplaceAll(text, ",", ""))
	value, err := strconv.ParseFloat(match, 64)
	if err != nil {
		return math.NaN()
	}
	return value
}

// comparisonDurationPhrase names an offset the way the UI's window label does: "1 h", "15 min", "7 d".
func comparisonDurationPhrase(seconds float64) string {
	value, unit := seconds, "s"
	switch {
	case seconds >= 86_400:
		value, unit = seconds/86_400, "d"
	case seconds >= 3_600:
		value, unit = seconds/3_600, "h"
	case seconds >= 60:
		value, unit = seconds/60, "min"
	}
	return fmt.Sprintf("%s %s", strconv.FormatFloat(math.Round(value*10)/10, 'f', -1, 64), unit)
}

// comparisonWindowText names the earlier window as the UI labels it: "1 h earlier" for the range length, "1 d" or "7 d".
func comparisonWindowText(compare *dashboardTextComparison) string {
	return comparisonDurationPhrase(compare.OffsetSeconds)
}

// comparisonChangeText is a change in the reading's own format, signed when it rises, and "≈0" when it rounds to nothing.
func comparisonChangeText(value float64, unit string, decimals *int, flat bool) string {
	if flat {
		return "≈" + dashboardReadingWithUnit(0, unit, decimals)
	}
	text := dashboardReadingWithUnit(value, unit, decimals)
	if value > 0 {
		return "+" + text
	}
	return text
}
