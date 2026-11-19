package insights

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// A rank decodes with the strictness of the zod rankSchema: an unknown member or a mistyped member is kept
// as a reason, so the server and the UI agree on which configs can rank.
func TestParseDashboardRecordTableKeepsAStrictRankDecodeError(t *testing.T) {
	for name, config := range map[string]string{
		"mistyped limit":  `{"rank":{"status":"cpu","limit":5.5}}`,
		"mistyped status": `{"rank":{"status":5}}`,
		"unknown member":  `{"rank":{"status":"cpu","bogus":true}}`,
	} {
		t.Run(name, func(t *testing.T) {
			table := parseDashboardRecordTable([]byte(config))
			require.Nil(t, table.Rank)
			require.Contains(t, table.RankErr, "rank does not decode")
		})
	}
	none := parseDashboardRecordTable([]byte(`{"cellStyles":[]}`))
	require.Nil(t, none.Rank)
	require.Empty(t, none.RankErr)
	nullRank := parseDashboardRecordTable([]byte(`{"rank":null,"cellStyles":[]}`))
	require.Nil(t, nullRank.Rank)
	require.Contains(t, nullRank.RankErr, "rank is null")
}

// The strictness matches the zod rankSchema member by member: a present null, an empty name, a name longer than
// the 128-character cap, a limit that is not a whole number, and a missing status each fail to decode.
func TestRecordRankDecodeRefusesWhatZodRefuses(t *testing.T) {
	long := strings.Repeat("x", 129)
	refused := map[string]string{
		"null rank":        `{"rank":null}`,
		"null status":      `{"rank":{"status":null}}`,
		"null value":       `{"rank":{"status":"cpu","value":null}}`,
		"null limit":       `{"rank":{"status":"cpu","limit":null}}`,
		"null rail":        `{"rank":{"status":"cpu","rail":null}}`,
		"null order":       `{"rank":{"status":"cpu","order":null}}`,
		"empty value":      `{"rank":{"status":"cpu","value":""}}`,
		"empty status":     `{"rank":{"status":""}}`,
		"missing status":   `{"rank":{"limit":3}}`,
		"status too long":  `{"rank":{"status":"` + long + `"}}`,
		"value too long":   `{"rank":{"status":"cpu","value":"` + long + `"}}`,
		"fractional limit": `{"rank":{"status":"cpu","limit":5.5}}`,
		"string limit":     `{"rank":{"status":"cpu","limit":"5"}}`,
	}
	for name, config := range refused {
		t.Run(name, func(t *testing.T) {
			table := parseDashboardRecordTable([]byte(config))
			require.Nil(t, table.Rank)
			require.NotEmpty(t, table.RankErr)
		})
	}
}

// A whole-number limit such as 5.0 is valid, as zod accepts it, and a name of exactly 128 characters is too.
func TestRecordRankDecodeAcceptsWhatZodAccepts(t *testing.T) {
	exact := strings.Repeat("x", 128)
	table := parseDashboardRecordTable([]byte(`{"rank":{"status":"` + exact + `","limit":5.0,"rail":false}}`))
	require.Empty(t, table.RankErr)
	require.NotNil(t, table.Rank)
	require.Equal(t, 5, *table.Rank.Limit)
	require.False(t, *table.Rank.Rail)
}

// An invalid rank that the zod schema refuses reports a reason and no band in query_dashboard.
func TestRankedRecordTableWithAMistypedRankReportsItsReason(t *testing.T) {
	frame := &dataframe.Frame{Columns: []dataframe.Column{{Key: "host", Type: "string"}}, Rows: [][]any{{"a"}}}
	widget := rankedHealthWidget(t, `{"rank":{"status":"host","limit":2.5}}`)
	applyDashboardSignal(&widget, &DashboardSignal{ID: "q1", State: "ok"}, &QueryResult{Records: frame}, 0)
	require.Nil(t, widget.Threshold)
	require.NotNil(t, widget.Ranking)
	require.Contains(t, widget.Ranking.Reason, "rank does not decode")
}

// Lint reports a rank that does not decode strictly as a plugin.record-rank error, as the UI refuses it.
func TestRecordRankThatDoesNotDecodeIsAnError(t *testing.T) {
	for name, config := range map[string]string{
		"mistyped limit":  `{"rank":{"status":"cpu","limit":5.5}}`,
		"mistyped status": `{"rank":{"status":5}}`,
		"unknown member":  `{"rank":{"status":"cpu","bogus":true}}`,
		"null rank":       `{"rank":null}`,
		"null limit":      `{"rank":{"status":"cpu","limit":null}}`,
		"null value":      `{"rank":{"status":"cpu","value":null}}`,
		"null rail":       `{"rank":{"status":"cpu","rail":null}}`,
		"empty value":     `{"rank":{"status":"cpu","value":""}}`,
		"long status":     `{"rank":{"status":"` + strings.Repeat("x", 129) + `"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			findings := lintFor(t, documentWithWidgets("rank", tableWidget("rank", config, true)))
			requireOneHitAmong(t, findings, "plugin.record-rank", "/widgets/0/config/rank")
		})
	}
	valid := lintFor(t, documentWithWidgets("whole", tableWidget("whole", `{"rank":{"status":"cpu","limit":5.0}}`, true)))
	requireNoHits(t, valid, "plugin.record-rank")
	// A whole-number limit written as 5.0 must not hide the column styles a status-badge rank reads its statuses from.
	badge := lintFor(t, documentWithWidgets("badge", tableWidget("badge", `{"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"critical"}]}],"rank":{"status":"health","limit":5.0}}`, false)))
	requireNoHits(t, badge, "plugin.record-rank")
}

// A status outside the five declared levels is undeclared, so it never reaches the ranking's statuses, and
// lint does not count it as a status source.
func TestRankedUndeclaredMappingNeverReachesTheStatuses(t *testing.T) {
	frame := &dataframe.Frame{
		Columns: []dataframe.Column{{Key: "host", Type: "string"}, {Key: "health", Type: "string"}},
		Rows:    [][]any{{"a", "Up"}, {"b", "Down"}},
	}
	styles := []dashboardRecordCellStyle{{
		Column:  "health",
		Display: "status-badge",
		Mappings: []dashboardRecordMapping{
			{Value: "Up", Status: "ok"},
			{Value: "Down", Status: "bogus"},
		},
	}}
	ranking, _, _ := rankDashboardRecords(frame, &dashboardRankedTable{rank: dashboardRecordRank{Status: "health"}, styles: styles})
	require.Equal(t, []string{"ok", "undeclared"}, ranking.Statuses)
	require.Equal(t, 1, ranking.Counts["undeclared"])

	findings := lintFor(t, documentWithWidgets("bogus", tableWidget("bogus",
		`{"rank":{"status":"health"},"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"bogus"}]}]}`, false)))
	requireOneHitAmong(t, findings, "plugin.record-rank", "/widgets/0/config/rank")
}
