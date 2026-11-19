package insights

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// The MCP preview shows the table's configured columns, capped at recordRankMaxColumns, and always keeps the
// rank's status and value columns, even when the table does not list them or the frame is wider than the cap.
func TestRankedPreviewProjectsConfiguredColumnsAndKeepsStatusAndValue(t *testing.T) {
	columns := make([]dataframe.Column, 0, 14)
	row := make([]any, 0, 14)
	for i := range 14 {
		key := "c" + string(rune('a'+i))
		columns = append(columns, dataframe.Column{Key: key, Type: "string"})
		row = append(row, key)
	}
	columns[13] = dataframe.Column{Key: "health", Type: "string"}
	columns[12] = dataframe.Column{Key: "cpu", Type: "number"}
	row[13], row[12] = "Down", 90.0
	frame := &dataframe.Frame{Columns: columns, Rows: [][]any{row}}
	rank := dashboardRecordRank{Status: "health", Value: "cpu"}

	indexes := previewColumnIndexes(frame, rank, []string{"ca", "cb", "cc", "cd", "ce", "cf", "cg", "ch", "ci", "cj", "ck", "cl", "cm"})
	require.Len(t, indexes, recordRankMaxColumns)
	keys := make([]string, 0, len(indexes))
	for _, index := range indexes {
		keys = append(keys, frame.Columns[index].Key)
	}
	require.Contains(t, keys, "health")
	require.Contains(t, keys, "cpu")
	require.Equal(t, "ca", keys[0])

	ordered := &recordRanking{shown: []int{0}, levels: []string{"critical"}}
	shown, rows, statuses := previewRecordRows(frame, indexes, ordered)
	require.Len(t, shown, recordRankMaxColumns)
	require.Len(t, rows[0], recordRankMaxColumns)
	require.Equal(t, []string{"critical"}, statuses)
}

// Without a configured column list, the preview takes frame order and still includes the status column.
func TestRankedPreviewWithoutConfiguredColumnsKeepsStatus(t *testing.T) {
	columns := make([]dataframe.Column, 0, 14)
	for i := range 14 {
		columns = append(columns, dataframe.Column{Key: "c" + string(rune('a'+i)), Type: "string"})
	}
	columns[13] = dataframe.Column{Key: "health", Type: "string"}
	frame := &dataframe.Frame{Columns: columns}
	indexes := previewColumnIndexes(frame, dashboardRecordRank{Status: "health"}, nil)
	require.Len(t, indexes, recordRankMaxColumns)
	require.Contains(t, indexes, 13)
}
