package insights

import (
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// recordRankingConformance mirrors docs/design/insights/conformance/record-ranking.json, which the UI
// test record-ranking-conformance.test.ts runs against rowStatus and rankRows.
type recordRankingConformance struct {
	Cases []struct {
		Name string `json:"name"`
		// Frame decodes through dataframe.Decode, as query_dashboard does, so numeric cells are json.Number.
		Frame      json.RawMessage            `json:"frame"`
		Rank       dashboardRecordRank        `json:"rank"`
		CellStyles []dashboardRecordCellStyle `json:"cellStyles"`
		Thresholds []dashboardReadThreshold   `json:"thresholds"`
		Expect     struct {
			Levels []string       `json:"levels"`
			Order  []int          `json:"order"`
			Shown  []int          `json:"shown"`
			Counts map[string]int `json:"counts"`
			Hidden struct {
				Rows     int `json:"rows"`
				Critical int `json:"critical"`
				Warning  int `json:"warning"`
			} `json:"hidden"`
		} `json:"expect"`
	} `json:"cases"`
}

func loadRecordRankingConformance(t *testing.T) recordRankingConformance {
	t.Helper()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/record-ranking.json")
	require.NoError(t, err)
	var fixture recordRankingConformance
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)
	return fixture
}

func TestRecordRankingMatchesTheSharedConformanceCases(t *testing.T) {
	for _, testCase := range loadRecordRankingConformance(t).Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			frame, err := dataframe.Decode(testCase.Frame)
			require.NoError(t, err)
			levels := make([]string, len(frame.Rows))
			for position, row := range frame.Rows {
				levels[position] = recordRowLevel(frame, row, testCase.Rank, testCase.CellStyles, testCase.Thresholds)
			}
			require.Equal(t, testCase.Expect.Levels, levels)
			ranked := rankRecordRows(frame, frame.Rows, testCase.Rank, testCase.CellStyles, testCase.Thresholds)
			require.Equal(t, testCase.Expect.Order, ranked.order)
			require.Equal(t, testCase.Expect.Shown, ranked.shown)
			require.Equal(t, testCase.Expect.Counts, ranked.counts)
			require.Equal(t, testCase.Expect.Hidden.Rows, ranked.hidden.Rows)
			require.Equal(t, testCase.Expect.Hidden.Critical, ranked.hidden.Critical)
			require.Equal(t, testCase.Expect.Hidden.Warning, ranked.hidden.Warning)
		})
	}
}

// TestRecordRowRankMatchesTheUIStatusOrder pins the Go level order to the UI's STATUS_RANK, which the
// attention reducer and the record ranking share.
func TestRecordRowRankMatchesTheUIStatusOrder(t *testing.T) {
	raw, err := os.ReadFile("../../ui/src/features/insights/status.ts")
	require.NoError(t, err)
	match := regexp.MustCompile(`STATUS_RANK[^=]*=\s*\{([^}]*)\}`).FindStringSubmatch(string(raw))
	require.NotNil(t, match, "UI source no longer declares STATUS_RANK")
	uiRank := map[string]int{}
	for _, entry := range strings.Split(match[1], ",") {
		parts := strings.SplitN(strings.TrimSpace(entry), ":", 2)
		require.Len(t, parts, 2)
		value, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		require.NoError(t, err)
		uiRank[strings.TrimSpace(parts[0])] = value
	}
	require.Len(t, uiRank, 5)
	for level, rank := range uiRank {
		require.Equal(t, rank, recordRowRank(level), level)
	}
	require.Less(t, recordRowRank("undeclared"), recordRowRank("ok"))
	require.Less(t, recordRowRank("missing"), recordRowRank("undeclared"))
}

func TestRecordRankingWithoutLimitShowsEveryRow(t *testing.T) {
	// Without the limit the counts and hidden stay zero, so the MCP output does not claim rows were cut.
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "host", Type: "string"}, {Key: "health", Type: "string"}}, Rows: [][]any{{"a", "Down"}, {"b", "Up"}}}
	styles := []dashboardRecordCellStyle{{Column: "health", Display: "status-badge", Mappings: []dashboardRecordMapping{{Value: "Down", Status: "critical"}, {Value: "Up", Status: "ok"}}}}
	ranking, worst, level := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "health"}, styles: styles})
	require.Equal(t, "critical", level)
	require.Equal(t, 0, worst, "the worst row is the first critical row in source order")
	require.Nil(t, ranking.Hidden)
	require.Equal(t, 2, ranking.Evaluated)
	require.Equal(t, []string{"critical", "ok"}, ranking.Statuses)
	require.Equal(t, "a", ranking.Rows[0][0])
}

func TestRecordRankingReportsAnInvalidRankAsAReasonWithoutABand(t *testing.T) {
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "host", Type: "string"}}, Rows: [][]any{{"a"}}}
	ranking, _, level := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "host"}})
	require.Empty(t, level, "an invalid rank never adds a band to attention")
	require.True(t, ranking.Partial)
	require.Contains(t, ranking.Reason, "host")
	require.Nil(t, ranking.Counts)
}

func TestRecordRankingStatesTruncationAndBoundsTheRows(t *testing.T) {
	columns := make([]dataframe.Column, 14)
	for index := range columns {
		columns[index] = dataframe.Column{Key: "c" + strconv.Itoa(index), Type: "string"}
	}
	columns[0] = dataframe.Column{Key: "state", Type: "string"}
	long := strings.Repeat("x", 400)
	rows := make([][]any, 12)
	for index := range rows {
		row := make([]any, len(columns))
		row[0] = "Up"
		row[1] = long
		rows[index] = row
	}
	frame := &dataframe.Frame{Columns: columns, Rows: rows, Truncated: true}
	styles := []dashboardRecordCellStyle{{Column: "state", Display: "status-badge", Mappings: []dashboardRecordMapping{{Value: "Up", Status: "ok"}}}}
	ranking, _, level := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "state"}, styles: styles})
	require.Equal(t, "ok", level)
	require.True(t, ranking.Partial)
	require.Equal(t, recordRankReasonTruncated, ranking.Reason)
	require.Len(t, ranking.Rows, recordRankMaxRows)
	require.Len(t, ranking.Columns, recordRankMaxColumns)
	require.Len(t, ranking.Rows[0], recordRankMaxColumns)
	text, isText := ranking.Rows[0][1].(string)
	require.True(t, isText)
	require.LessOrEqual(t, len(text), recordRankMaxText)
}

// Records decode with UseNumber, so a numeric cell is a json.Number. Ranking must read it as a number, or
// every numeric status is missing and no table with a numeric status is ever ranked.
func TestRecordRankingReadsDecodedNumericCells(t *testing.T) {
	frame, err := dataframe.Decode(json.RawMessage(`{"columns":[{"key":"host","type":"string"},{"key":"cpu","type":"number"}],"rows":[["a",10],["b",95],["c",50]]}`))
	require.NoError(t, err)
	thresholds := []dashboardReadThreshold{{Value: 0, Status: "ok"}, {Value: 90, Status: "critical"}}
	ranking, worst, level := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "cpu"}, thresholds: thresholds})
	require.Equal(t, "critical", level)
	require.Equal(t, 1, worst)
	require.Equal(t, 1, ranking.Counts["critical"])
	require.Equal(t, 2, ranking.Counts["ok"])
	require.Equal(t, 0, ranking.Counts["missing"])
	require.Equal(t, []string{"critical", "ok", "ok"}, ranking.Statuses)
	require.Equal(t, "b", ranking.Rows[0][0])
}

func TestRecordRankingLimitHidesRowsAndCountsCriticalAndWarningRows(t *testing.T) {
	frame := &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "host", Type: "string"}, {Key: "health", Type: "string"}},
		Rows:    [][]any{{"a", "Up"}, {"b", "Down"}, {"c", "Degraded"}},
	}
	styles := []dashboardRecordCellStyle{{Column: "health", Display: "status-badge", Mappings: []dashboardRecordMapping{{Value: "Down", Status: "critical"}, {Value: "Degraded", Status: "warning"}, {Value: "Up", Status: "ok"}}}}
	one := 1
	ranking, worst, level := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "health", Limit: &one}, styles: styles})
	require.Equal(t, "critical", level)
	require.Equal(t, 1, worst)
	require.Equal(t, &DashboardRecordHidden{Rows: 2, Critical: 0, Warning: 1}, ranking.Hidden)
	require.Len(t, ranking.Rows, 1)
	require.Equal(t, "b", ranking.Rows[0][0])
}

// rankedHealthWidget is a record-table whose status is the health column, read from the planned output.
func rankedHealthWidget(t *testing.T, config string) DashboardQueryWidget {
	t.Helper()
	widget := &dashboardReadWidget{ID: "hosts", Title: "Hosts", Type: "plugin", PluginID: "record-table", DataKind: "records", Config: json.RawMessage(config)}
	output := dashboardQueryWidgetOutput(widget)
	output.SignalID = "q1"
	return output
}

func TestRankedRecordTableCountsTowardAttentionAndNoRankDoesNot(t *testing.T) {
	frame := &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "host", Type: "string"}, {Key: "health", Type: "string"}},
		Rows:    [][]any{{"a", "Up"}, {"b", "Down"}},
	}
	ranked := rankedHealthWidget(t, `{"columns":["host","health"],"rank":{"status":"health"},"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"critical"},{"value":"Up","status":"ok"}]}]}`)
	signal := &DashboardSignal{ID: "q1", State: "ok"}
	applyDashboardSignal(&ranked, signal, &QueryResult{Records: frame}, 0)
	require.NotNil(t, ranked.Threshold)
	require.Equal(t, "matched", ranked.Threshold.State)
	require.Equal(t, "critical", ranked.Threshold.Status)
	require.NotNil(t, ranked.Ranking)
	require.Equal(t, 1, ranked.Ranking.Counts["critical"])
	require.Equal(t, 1, *ranked.BandSeries.Series, "the worst row is the critical row, at its source position")

	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{ranked}, Signals: []DashboardSignal{*signal}}
	attention := applyDashboardAttention(result)
	require.Equal(t, 1, attention.Critical, "a ranked table with a critical row counts as critical")

	plain := rankedHealthWidget(t, `{"columns":["host","health"],"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"critical"}]}]}`)
	applyDashboardSignal(&plain, signal, &QueryResult{Records: frame}, 0)
	require.Nil(t, plain.Threshold, "a table without rank never adds to attention")
	require.Nil(t, plain.Ranking)
}

func TestInvalidRankSetsNoBandAndNamesTheReason(t *testing.T) {
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "host", Type: "string"}}, Rows: [][]any{{"a"}}}
	widget := rankedHealthWidget(t, `{"rank":{"status":"host"}}`)
	applyDashboardSignal(&widget, &DashboardSignal{ID: "q1", State: "ok"}, &QueryResult{Records: frame}, 0)
	require.Nil(t, widget.Threshold)
	require.Nil(t, widget.BandSeries)
	require.NotNil(t, widget.Ranking)
	require.NotEmpty(t, widget.Ranking.Reason)
}

func TestRankedRecordTableWithoutRowsSetsNoBand(t *testing.T) {
	widget := rankedHealthWidget(t, `{"rank":{"status":"health"}}`)
	applyDashboardSignal(&widget, &DashboardSignal{ID: "q1", State: "error", Error: &DashboardQueryError{Code: "x", Message: "failed"}}, nil, 0)
	require.Nil(t, widget.Threshold)
	require.NotNil(t, widget.Ranking)
	require.Equal(t, "no loaded rows to rank", widget.Ranking.Reason)
}

// A ranked table whose loaded rows declare no status keeps an unknown band, and its band series still counts
// the rows it read, so no reader takes a read of zero rows for a table that had two.
func TestRankedRecordTableWithoutDeclaredRowsKeepsItsEvaluatedCount(t *testing.T) {
	frame := &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "host", Type: "string"}, {Key: "health", Type: "string"}},
		Rows:    [][]any{{"a", nil}, {"b", nil}},
	}
	widget := rankedHealthWidget(t, `{"columns":["host","health"],"rank":{"status":"health"},"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"critical"}]}]}`)
	applyDashboardSignal(&widget, &DashboardSignal{ID: "q1", State: "ok"}, &QueryResult{Records: frame}, 0)
	require.NotNil(t, widget.Threshold)
	require.Equal(t, "unknown", widget.Threshold.State)
	require.NotNil(t, widget.BandSeries)
	require.Equal(t, 2, widget.BandSeries.Evaluated)
	require.Nil(t, widget.BandSeries.Series)
}
