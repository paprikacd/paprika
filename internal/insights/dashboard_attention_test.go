package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// attentionConformance mirrors docs/design/insights/conformance/attention.json.
type attentionConformance struct {
	Cases []struct {
		Name    string `json:"name"`
		Widgets []struct {
			ID        string `json:"id"`
			Failure   string `json:"failure"`
			Signal    string `json:"signal"`
			Threshold *struct {
				State  string `json:"state"`
				Status string `json:"status"`
			} `json:"threshold"`
			Breaches *struct {
				Summary []struct {
					Level     string `json:"level"`
					Intervals int    `json:"intervals"`
					Samples   int    `json:"samples"`
				} `json:"summary"`
			} `json:"breaches"`
			Freshness *string `json:"freshness"`
		} `json:"widgets"`
		Expected struct {
			Widgets   int               `json:"widgets"`
			Checked   int               `json:"checked"`
			Critical  int               `json:"critical"`
			Warning   int               `json:"warning"`
			Failed    int               `json:"failed"`
			Stale     int               `json:"stale"`
			Attention map[string]string `json:"attention"`
		} `json:"expected"`
	} `json:"cases"`
}

// attentionResult builds the reduced widget and signal facts a fixture describes.
func attentionResult(t *testing.T, fixture attentionConformance, index int) *DashboardQueryResult {
	t.Helper()
	result := &DashboardQueryResult{}
	for position, entry := range fixture.Cases[index].Widgets {
		signalID := ""
		if entry.Signal != "none" {
			signalID = "q" + string(rune('1'+position))
			signal := DashboardSignal{ID: signalID, State: entry.Signal}
			if entry.Failure == "provider" {
				signal.State, signal.Error = "error", &DashboardQueryError{Code: "provider_error", Message: "failed"}
			}
			result.Signals = append(result.Signals, signal)
		}
		widget := DashboardQueryWidget{ID: entry.ID, SignalID: signalID}
		if entry.Failure == "planning" {
			widget.Error = &DashboardQueryError{Code: "missing_saved_query", Message: "missing"}
		}
		if entry.Threshold != nil {
			widget.Threshold = &DashboardStatThreshold{State: entry.Threshold.State}
			if entry.Threshold.Status != "" {
				widget.Threshold.Status = entry.Threshold.Status
			}
		}
		if entry.Breaches != nil {
			widget.Breaches = &DashboardBreaches{}
			for _, level := range entry.Breaches.Summary {
				widget.Breaches.Summary = append(widget.Breaches.Summary, DashboardBreachLevel{Level: level.Level, Intervals: level.Intervals, Samples: level.Samples})
			}
		}
		if entry.Freshness != nil {
			widget.Sample = &DashboardSample{State: *entry.Freshness}
		}
		result.Widgets = append(result.Widgets, widget)
	}
	return result
}

func TestAttentionConformanceMatchesSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/attention.json")
	require.NoError(t, err)
	var fixture attentionConformance
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)
	for index, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			result := attentionResult(t, fixture, index)
			attention := applyDashboardAttention(result)
			require.Equal(t, dashboardAttentionBasis, attention.Basis)
			require.Equal(t, testCase.Expected.Widgets, attention.Widgets)
			require.Equal(t, testCase.Expected.Checked, attention.Checked)
			require.Equal(t, testCase.Expected.Critical, attention.Critical)
			require.Equal(t, testCase.Expected.Warning, attention.Warning)
			require.Equal(t, testCase.Expected.Failed, attention.Failed)
			require.Equal(t, testCase.Expected.Stale, attention.Stale)
			got := map[string]string{}
			for _, widget := range result.Widgets {
				if widget.Attention != "" {
					got[widget.ID] = widget.Attention
				}
			}
			require.Equal(t, testCase.Expected.Attention, got)
		})
	}
}
