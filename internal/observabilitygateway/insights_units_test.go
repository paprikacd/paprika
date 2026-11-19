package observabilitygateway

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// Agent text scales a unit family before it applies the widget's decimals, as the UI does: one step, then the places.
func TestDashboardReadingScalesBeforeDecimals(t *testing.T) {
	three, zero, two := 3, 0, 2
	require.Equal(t, "269.486 TiB", dashboardReadingWithUnit(296303060975000, "bytes", &three))
	require.Equal(t, "269 TiB", dashboardReadingWithUnit(296303060975000, "bytes", nil))
	require.Equal(t, "269 TiB", dashboardReadingWithUnit(296303060975000, "bytes", &zero))
	require.Equal(t, "1.5K req/s", dashboardReadingWithUnit(1500, "req/s", nil))
	require.Equal(t, "2.02 s", dashboardReadingWithUnit(2024, "ms", &two))
	require.Equal(t, "1 s", dashboardReadingWithUnit(999.5, "ms", nil))
	require.Equal(t, "84 ms", dashboardReadingWithUnit(84, "ms", nil))
	require.Equal(t, "84.000 ms", dashboardReadingWithUnit(84, "ms", &three))
	require.Equal(t, "78.000%", dashboardReadingWithUnit(78, "%", &three))
}

// Unit-less whole numbers are counts or identifiers: they stay whole at any setting.
func TestDashboardReadingKeepsUnitlessWholeNumbersWhole(t *testing.T) {
	three := 3
	require.Equal(t, "84", dashboardReadingWithUnit(84, "", &three))
	require.Equal(t, "18432", dashboardReadingWithUnit(18432, "", nil))
	require.Equal(t, "5.879", dashboardReadingWithUnit(5.878749999999975, "", &three))
	require.Equal(t, "0.3", dashboardReadingWithUnit(0.1+0.2, "", nil))
}

// No reading prints a float-noise digit run or an unscaled 15-digit value.
func TestDashboardReadingHasNoFloatNoiseOrRawBytes(t *testing.T) {
	three := 3
	for _, value := range []float64{5.878749999999975, 296303060975000, 0.1 + 0.2, 1234567.5} {
		for _, decimals := range []*int{nil, &three} {
			text := dashboardReadingWithUnit(value, "bytes", decimals)
			require.NotContains(t, text, "296303060975000")
			require.NotRegexp(t, `\.\d{9,}`, text)
		}
	}
}

func TestDashboardGroupAndFixedRoundHalfUpOnTheShortestDecimal(t *testing.T) {
	require.Equal(t, "1,234.5", dashboardFixed(1234.5, 1))
	require.Equal(t, "0.13", dashboardFixed(0.125, 2))
	require.Equal(t, "0", dashboardFixed(-0.0001, 0))
	require.Equal(t, "-1.50", dashboardFixed(-1.5, 2))
}

// A record cell with a unit takes its column's family: a unit-less identifier keeps its stored digits.
func TestDashboardRecordScalarTextScalesUnitColumns(t *testing.T) {
	three, zeroDecimals := 3, 0
	require.Equal(t, "269.486 TiB", dashboardRecordScalarText(json.RawMessage("296303060975000"), "bytes", &three))
	require.Equal(t, "296303060975000", dashboardRecordScalarText(json.RawMessage("296303060975000"), "", nil))
	require.Equal(t, "86,400 s", dashboardRecordScalarText(json.RawMessage("86400000"), "ms", &zeroDecimals))
}

// Percent in Auto keeps two places from one upwards, adds places rather than rounding a value below 100 up to 100,
// and matches the UI's percent rule.
func TestDashboardPercentAutoNeverRoundsBelowHundredToHundred(t *testing.T) {
	require.Equal(t, "99.95%", dashboardReadingWithUnit(99.95, "%", nil))
	require.Equal(t, "99.98%", dashboardReadingWithUnit(99.98, "%", nil))
	require.Equal(t, "99.999%", dashboardReadingWithUnit(99.999, "%", nil))
	require.Equal(t, "1,023.6%", dashboardReadingWithUnit(1023.6, "%", nil))
	require.Equal(t, "100%", dashboardReadingWithUnit(100, "%", nil))
	require.Equal(t, "17.6%", dashboardReadingWithUnit(17.6, "%", nil))
}

// Percent adds places one at a time until the value stops reading as 100, so 99.99951234 keeps four places ("99.9995%"),
// where a fall-back to the exact form would print eight.
func TestDashboardPercentAutoAddsPlacesUntilNotHundred(t *testing.T) {
	require.Equal(t, "99.9995%", dashboardReadingWithUnit(99.99951234, "%", nil))
	require.Equal(t, "-99.9995%", dashboardReadingWithUnit(-99.99951234, "%", nil))
}

// Exponents are written as the UI writes them: no leading zero in the exponent ("1e-7", not "1e-07").
func TestDashboardAutoExponentHasNoLeadingZero(t *testing.T) {
	require.Equal(t, "1e-7", dashboardReadingWithUnit(1e-7, "", nil))
	require.Equal(t, "2.5e+15", dashboardReadingWithUnit(2.5e15, "", nil))
}
