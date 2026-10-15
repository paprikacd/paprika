package connector

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSignalValues(t *testing.T) {
	t.Parallel()
	require.Equal(t, Signal("logs"), SignalLogs)
	require.Equal(t, Signal("metrics"), SignalMetrics)
	require.Equal(t, Signal("traces"), SignalTraces)
}

func TestCanSupplyGovernsWhichSignalsMayReportOK(t *testing.T) {
	t.Parallel()
	d := Descriptor{Name: "logs-and-traces", Signals: []Signal{SignalLogs, SignalTraces}}
	require.True(t, d.CanSupply(SignalLogs))
	require.True(t, d.CanSupply(SignalTraces))
	// A connector that cannot serve a signal must never be treated as if it
	// can, so callers route the query to a connector that advertises it.
	require.False(t, d.CanSupply(SignalMetrics))
}
