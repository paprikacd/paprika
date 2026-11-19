package insights

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode/utf16"

	"github.com/benebsworth/paprika/internal/dataframe"
)

// This file ports the record-table ranking the UI applies (ui/src/features/insights/plugins/record-ranking.ts)
// to query_dashboard. The shared cases in docs/design/insights/conformance/record-ranking.json pin both.

// recordRankBasis states what a ranking counts, so no reader takes it for a health verdict.
const recordRankBasis = "author-declared row statuses over loaded rows; not a health verdict"

// recordRankReasonTruncated says what a truncated frame's ranking covers.
const recordRankReasonTruncated = "ranked among loaded rows only; order the query to rank the whole source"

// Bounds the MCP output keeps for a ranking: at most this many ranked rows, each showing at most
// recordRankMaxColumns columns, with strings capped at recordRankMaxText characters.
const (
	recordRankMaxRows    = 10
	recordRankMaxColumns = 12
	recordRankMaxText    = 160
)

// dashboardRecordTable is the part of a record-table config the ranking reads. The UI validates the
// full config; the server reads what it needs. A rank that does not decode strictly is kept as a reason
// (RankErr), not dropped, so the ranking reports why it cannot rank, as the UI refuses the same config.
type dashboardRecordTable struct {
	Rank       *dashboardRecordRank
	RankErr    string
	CellStyles []dashboardRecordCellStyle
	Columns    []string
}

// dashboardRecordRank mirrors the zod rankSchema. Order and Limit are pointers or strings so a missing
// member keeps its default.
type dashboardRecordRank struct {
	Status string `json:"status"`
	Value  string `json:"value"`
	Order  string `json:"order"`
	Limit  *int   `json:"limit"`
	Rail   *bool  `json:"rail"`
}

// dashboardRecordCellStyle is one column style: the members that declare a status source.
type dashboardRecordCellStyle struct {
	Column     string                   `json:"column"`
	Display    string                   `json:"display"`
	Mappings   []dashboardRecordMapping `json:"mappings"`
	Thresholds []dashboardReadThreshold `json:"thresholds"`
}

type dashboardRecordMapping struct {
	Value  string `json:"value"`
	Status string `json:"status"`
	Color  string `json:"color"`
}

// dashboardRankedTable is a ranked record-table widget's rank with the styles and widget thresholds it reads.
// invalid, when set, is why the rank does not decode, and the ranking reports it instead of ranking.
type dashboardRankedTable struct {
	rank       dashboardRecordRank
	invalid    string
	styles     []dashboardRecordCellStyle
	thresholds []dashboardReadThreshold
	columns    []string
}

// DashboardRecordRanking is a record-table's ranking over its loaded rows. Counts cover every loaded row;
// Rows and Statuses are the first ranked rows the limit keeps, bounded for the MCP output. Hidden counts
// the rows the limit cut, including the critical and warning ones.
type DashboardRecordRanking struct {
	Basis     string                 `json:"basis"`
	Status    string                 `json:"status,omitempty"`
	Value     string                 `json:"value,omitempty"`
	Order     string                 `json:"order,omitempty"`
	Evaluated int                    `json:"evaluated"`
	Limit     *int                   `json:"limit,omitempty"`
	Counts    map[string]int         `json:"counts,omitempty"`
	Hidden    *DashboardRecordHidden `json:"hidden,omitempty"`
	Columns   []dataframe.Column     `json:"columns,omitempty"`
	Rows      [][]any                `json:"rows,omitempty"`
	Statuses  []string               `json:"statuses,omitempty"`
	Partial   bool                   `json:"partial,omitempty"`
	Reason    string                 `json:"reason,omitempty"`
}

// DashboardRecordHidden counts the ranked rows the limit cut.
type DashboardRecordHidden struct {
	Rows     int `json:"rows"`
	Critical int `json:"critical"`
	Warning  int `json:"warning"`
}

// recordRowLevels are every level a ranked row can take, in the order the counts are reported.
var recordRowLevels = []string{"critical", "warning", "unknown", "info", "ok", "undeclared", "missing"}

// declaredRankLevel is status when it is one of the five declared levels. Any other status, which the
// server does not validate in plugin config, is undeclared, so it never reaches the output's statuses enum.
func declaredRankLevel(status string) string {
	switch status {
	case "critical", "warning", "unknown", "info", "ok":
		return status
	}
	return "undeclared"
}

// recordRowRank orders a level worst first. Declared statuses use the attention order; a colour-only
// or unmapped value (undeclared) and a missing value sort below every declared status.
func recordRowRank(level string) int {
	switch level {
	case "undeclared":
		return -1
	case "missing":
		return -2
	}
	return dashboardStatusRank(level)
}

// parseDashboardRecordTable reads a record-table config. The rank decodes strictly, as the zod rankSchema
// does: an unknown member, a null, an empty value or a value of the wrong type is kept as RankErr. A config
// that is not an object has no rank and no styles.
func parseDashboardRecordTable(config json.RawMessage) dashboardRecordTable {
	var raw struct {
		Rank       json.RawMessage `json:"rank"`
		CellStyles json.RawMessage `json:"cellStyles"`
		Columns    json.RawMessage `json:"columns"`
	}
	if len(config) == 0 || json.Unmarshal(config, &raw) != nil {
		return dashboardRecordTable{}
	}
	var table dashboardRecordTable
	table.Rank, table.RankErr = decodeStrictRecordRank(raw.Rank)
	if len(raw.Columns) > 0 && json.Unmarshal(raw.Columns, &table.Columns) != nil {
		table.Columns = nil
	}
	if len(raw.CellStyles) > 0 && json.Unmarshal(raw.CellStyles, &table.CellStyles) != nil {
		table.CellStyles = nil
	}
	return table
}

// recordRankNameMax is the zod length cap on a rank's column names, counted in UTF-16 units as zod counts them.
const recordRankNameMax = 128

// decodeStrictRecordRank decodes a rank with the strictness of the zod rankSchema. An absent rank declares
// none. A null rank, an unknown or null member, an empty or over-long name, a limit that is not a whole
// number, and a missing status are each an error, which the caller reports as a reason.
func decodeStrictRecordRank(raw json.RawMessage) (rank *dashboardRecordRank, reason string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, ""
	}
	if string(trimmed) == "null" {
		return nil, "rank does not decode: rank is null; omit it to declare no rank"
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &members); err != nil {
		return nil, "rank does not decode: " + err.Error()
	}
	names := make([]string, 0, len(members))
	for name := range members {
		names = append(names, name)
	}
	sort.Strings(names)
	var decoded dashboardRecordRank
	for _, name := range names {
		if err := decodeRankMember(name, members[name], &decoded); err != nil {
			return nil, "rank does not decode: " + err.Error()
		}
	}
	if _, present := members["status"]; !present {
		return nil, "rank does not decode: status is required"
	}
	return &decoded, ""
}

// decodeRankMember decodes one rank member into rank. Null is refused for every member, as the zod schema refuses it.
func decodeRankMember(name string, value json.RawMessage, rank *dashboardRecordRank) error {
	if string(bytes.TrimSpace(value)) == "null" {
		return fmt.Errorf("%s is null", name)
	}
	switch name {
	case "status":
		text, err := decodeRankName(name, value)
		rank.Status = text
		return err
	case "value":
		text, err := decodeRankName(name, value)
		rank.Value = text
		return err
	case "order":
		text, err := decodeRankName(name, value)
		rank.Order = text
		return err
	case "limit":
		limit, err := decodeRankLimit(value)
		rank.Limit = limit
		return err
	case "rail":
		var flag bool
		if err := json.Unmarshal(value, &flag); err != nil {
			return errors.New("rail must be true or false")
		}
		rank.Rail = &flag
		return nil
	}
	return fmt.Errorf("unknown member %q", name)
}

// decodeRankName reads a column name: text that is not empty and, for a column, at most recordRankNameMax
// UTF-16 units. The order member is an enum that lint checks, so only its emptiness is refused here.
func decodeRankName(name string, value json.RawMessage) (string, error) {
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return "", fmt.Errorf("%s must be text", name)
	}
	if text == "" {
		return "", fmt.Errorf("%s is empty", name)
	}
	if name != "order" && len(utf16.Encode([]rune(text))) > recordRankNameMax {
		return "", fmt.Errorf("%s is longer than %d characters", name, recordRankNameMax)
	}
	return text, nil
}

// decodeRankLimit reads a limit that is a whole number, so 5.0 is valid and 5.5 is not. A JSON string also
// parses as a json.Number, so a string is refused before the number is read.
func decodeRankLimit(value json.RawMessage) (*int, error) {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) == 0 || trimmed[0] == '"' {
		return nil, errors.New("limit must be a whole number")
	}
	var number json.Number
	if err := json.Unmarshal(trimmed, &number); err != nil {
		return nil, errors.New("limit must be a whole number")
	}
	whole, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || whole != math.Trunc(whole) || math.Abs(whole) > 1e9 {
		return nil, errors.New("limit must be a whole number")
	}
	limit := int(whole)
	return &limit, nil
}

// recordColumnIndex is the position of a result column by key, or -1.
func recordColumnIndex(frame *dataframe.Frame, key string) int {
	for index, column := range frame.Columns {
		if column.Key == key {
			return index
		}
	}
	return -1
}

// recordCellStyle is the style declared for a column, or nil.
func recordCellStyle(styles []dashboardRecordCellStyle, column string) *dashboardRecordCellStyle {
	for index := range styles {
		if styles[index].Column == column {
			return &styles[index]
		}
	}
	return nil
}

// recordNumber reads a finite number from a result cell. Records decode with UseNumber, so numeric cells
// arrive as json.Number; dataframe.Number accepts those and the Go numeric kinds. Strings, booleans and
// nulls are not numbers.
func recordNumber(value any) (float64, bool) {
	number, err := dataframe.Number(value)
	return number, err == nil
}

// recordValueAt reads the numeric value of a row at a column index, or reports false when it has none.
func recordValueAt(row []any, index int) (float64, bool) {
	if index < 0 || index >= len(row) {
		return 0, false
	}
	return recordNumber(row[index])
}

// resolvedRecordThresholds is a column's own thresholds when it sets any, else the widget's.
func resolvedRecordThresholds(style *dashboardRecordCellStyle, widget []dashboardReadThreshold) []dashboardReadThreshold {
	if style != nil && len(style.Thresholds) > 0 {
		return style.Thresholds
	}
	return widget
}

// recordRowLevel is one row's status in the rank. A status comes only from a status-badge mapping or from a
// threshold that names a status, so a status word is never inferred.
func recordRowLevel(frame *dataframe.Frame, row []any, rank dashboardRecordRank, styles []dashboardRecordCellStyle, thresholds []dashboardReadThreshold) string {
	index := recordColumnIndex(frame, rank.Status)
	if index < 0 || index >= len(row) {
		return "missing"
	}
	style := recordCellStyle(styles, rank.Status)
	if style != nil && style.Display == "status-badge" {
		return badgeRowLevel(row[index], style.Mappings)
	}
	number, isNumber := recordNumber(row[index])
	if !isNumber {
		return "missing"
	}
	bands := resolvedRecordThresholds(style, thresholds)
	if len(bands) == 0 {
		return "undeclared"
	}
	return declaredRankLevel(matchDashboardBand(number, bands).Status)
}

// badgeRowLevel is the status of a status-badge cell: its mapped status, undeclared when the label has no
// status, and missing when the cell is empty.
func badgeRowLevel(value any, mappings []dashboardRecordMapping) string {
	if value == nil {
		return "missing"
	}
	label, isText := value.(string)
	if !isText {
		return "undeclared"
	}
	if label == "" {
		return "missing"
	}
	for _, mapping := range mappings {
		if mapping.Value == label {
			return declaredRankLevel(mapping.Status)
		}
	}
	return "undeclared"
}

// recordRankError says why a rank cannot be drawn, or returns empty when it can. It mirrors the UI's
// rankTableError, so an invalid rank never ranks by nothing.
func recordRankError(frame *dataframe.Frame, rank dashboardRecordRank, styles []dashboardRecordCellStyle, thresholds []dashboardReadThreshold) string {
	index := recordColumnIndex(frame, rank.Status)
	if index < 0 {
		return fmt.Sprintf("the query result has no %q column to rank by", rank.Status)
	}
	if reason := rankStatusError(frame.Columns[index], rank.Status, styles, thresholds); reason != "" {
		return reason
	}
	if rank.Value != "" {
		if reason := rankValueError(frame, rank.Value); reason != "" {
			return reason
		}
	}
	return rankOptionError(rank)
}

// rankStatusError says why the status column cannot supply a status, or returns empty when it can.
func rankStatusError(column dataframe.Column, status string, styles []dashboardRecordCellStyle, thresholds []dashboardReadThreshold) string {
	style := recordCellStyle(styles, status)
	if style != nil && style.Display == "status-badge" {
		if !hasStatusMapping(style.Mappings) {
			return fmt.Sprintf("rank status %q needs a status mapping", status)
		}
		return ""
	}
	if column.Type != "number" {
		return fmt.Sprintf("rank status needs a status-badge column or a numeric column with thresholds; %q is %s", status, column.Type)
	}
	if !hasStatusBand(resolvedRecordThresholds(style, thresholds)) {
		return fmt.Sprintf("rank status %q needs thresholds that name a status", status)
	}
	return ""
}

// rankValueError says why the value column cannot order rows, or returns empty when it can.
func rankValueError(frame *dataframe.Frame, value string) string {
	valueIndex := recordColumnIndex(frame, value)
	if valueIndex < 0 {
		return fmt.Sprintf("the query result has no %q column to order by", value)
	}
	if frame.Columns[valueIndex].Type != "number" {
		return fmt.Sprintf("rank order requires a numeric column; %q is %s", value, frame.Columns[valueIndex].Type)
	}
	return ""
}

// rankOptionError says why the order, limit or value choice is invalid, or returns empty when it is valid.
func rankOptionError(rank dashboardRecordRank) string {
	switch rank.Order {
	case "", "descending", "ascending":
	default:
		return fmt.Sprintf("rank order %q is not descending or ascending", rank.Order)
	}
	if rank.Limit != nil && (*rank.Limit < 1 || *rank.Limit > 100) {
		return "rank limit must be between 1 and 100"
	}
	if rank.Value != "" && rank.Value == rank.Status {
		return "order a ranked table by a different column than its status"
	}
	return ""
}

func hasStatusMapping(mappings []dashboardRecordMapping) bool {
	for _, mapping := range mappings {
		if declaredRankLevel(mapping.Status) != "undeclared" {
			return true
		}
	}
	return false
}

func hasStatusBand(bands []dashboardReadThreshold) bool {
	for _, band := range bands {
		if declaredRankLevel(band.Status) != "undeclared" {
			return true
		}
	}
	return false
}

// recordRanking is the core ordering over a set of rows, the Go form of the UI's rankRows.
type recordRanking struct {
	// order holds positions in rows, worst first, before the limit.
	order []int
	// levels holds each row's level, by position in rows.
	levels []string
	// counts covers every row.
	counts map[string]int
	// shown holds the positions the limit keeps, worst first.
	shown  []int
	hidden DashboardRecordHidden
}

// classifyRecordRows gives each row its level and counts the levels.
func classifyRecordRows(frame *dataframe.Frame, rows [][]any, rank dashboardRecordRank, styles []dashboardRecordCellStyle, thresholds []dashboardReadThreshold) (levels []string, counts map[string]int) {
	levels = make([]string, len(rows))
	counts = make(map[string]int, len(recordRowLevels))
	for _, level := range recordRowLevels {
		counts[level] = 0
	}
	for position, row := range rows {
		levels[position] = recordRowLevel(frame, row, rank, styles, thresholds)
		counts[levels[position]]++
	}
	return levels, counts
}

// orderRecordRows returns the row positions worst first: by level, then by the value column in the given
// order with missing values last, then by source position.
func orderRecordRows(rows [][]any, levels []string, valueIndex int, order string) []int {
	direction := -1.0
	if order == "ascending" {
		direction = 1
	}
	positions := make([]int, len(rows))
	for position := range positions {
		positions[position] = position
	}
	sort.SliceStable(positions, func(i, j int) bool {
		return recordRowBefore(rows, levels, valueIndex, direction, positions[i], positions[j])
	})
	return positions
}

// recordRowBefore reports whether row left sorts before row right in the rank.
func recordRowBefore(rows [][]any, levels []string, valueIndex int, direction float64, left, right int) bool {
	if byLevel := recordRowRank(levels[left]) - recordRowRank(levels[right]); byLevel != 0 {
		return byLevel > 0
	}
	leftValue, leftOK := recordValueAt(rows[left], valueIndex)
	rightValue, rightOK := recordValueAt(rows[right], valueIndex)
	if leftOK != rightOK {
		return leftOK
	}
	if leftOK && leftValue != rightValue {
		return (leftValue-rightValue)*direction < 0
	}
	return left < right
}

// rankRecordRows ranks rows by level (worst first), then by the rank's value column in its order with
// missing values last, then by source position. The limit keeps the top rows and counts what it cut.
func rankRecordRows(frame *dataframe.Frame, rows [][]any, rank dashboardRecordRank, styles []dashboardRecordCellStyle, thresholds []dashboardReadThreshold) recordRanking {
	levels, counts := classifyRecordRows(frame, rows, rank, styles, thresholds)
	valueIndex := -1
	if rank.Value != "" {
		valueIndex = recordColumnIndex(frame, rank.Value)
	}
	order := orderRecordRows(rows, levels, valueIndex, rank.Order)
	limit := len(order)
	if rank.Limit != nil && *rank.Limit < limit {
		limit = *rank.Limit
	}
	ranking := recordRanking{order: order, levels: levels, counts: counts, shown: order[:limit]}
	for _, position := range order[limit:] {
		ranking.hidden.Rows++
		switch levels[position] {
		case "critical":
			ranking.hidden.Critical++
		case "warning":
			ranking.hidden.Warning++
		}
	}
	return ranking
}

// worstRecordRow is the position of the first row, in source order, whose level is the most severe
// declared one, with that level. It returns -1 and empty when no row declares a status.
func worstRecordRow(levels []string) (position int, level string) {
	worst := ""
	for _, level := range levels {
		if recordRowRank(level) < 0 {
			continue
		}
		if worst == "" || recordRowRank(level) > recordRowRank(worst) {
			worst = level
		}
	}
	if worst == "" {
		return -1, ""
	}
	for position, level := range levels {
		if level == worst {
			return position, worst
		}
	}
	return -1, ""
}

// previewColumnIndexes picks the frame columns the preview shows, at most recordRankMaxColumns. The table's own
// columns come first, in their configured order, or in frame order when it lists none. The rank's status and
// value columns always show: when they are not listed they are added, and room is made by dropping unlisted
// columns from the end.
func previewColumnIndexes(frame *dataframe.Frame, rank dashboardRecordRank, configured []string) []int {
	keys := configured
	if len(keys) == 0 {
		for _, column := range frame.Columns {
			keys = append(keys, column.Key)
		}
	}
	required := map[int]bool{}
	for _, key := range []string{rank.Status, rank.Value} {
		if index := recordColumnIndex(frame, key); index >= 0 {
			required[index] = true
		}
	}
	indexes := previewCandidates(frame, append(append([]string{}, keys...), rank.Status, rank.Value))
	for len(indexes) > recordRankMaxColumns {
		dropped := false
		for position := len(indexes) - 1; position >= 0 && !dropped; position-- {
			if !required[indexes[position]] {
				indexes = append(indexes[:position], indexes[position+1:]...)
				dropped = true
			}
		}
		if !dropped {
			break
		}
	}
	return indexes[:min(len(indexes), recordRankMaxColumns)]
}

// previewCandidates lists the distinct frame columns named by keys, in the order given. Unknown and empty keys are skipped.
func previewCandidates(frame *dataframe.Frame, keys []string) []int {
	indexes := make([]int, 0, len(keys))
	seen := map[int]bool{}
	for _, key := range keys {
		index := recordColumnIndex(frame, key)
		if key == "" || index < 0 || seen[index] {
			continue
		}
		seen[index] = true
		indexes = append(indexes, index)
	}
	return indexes
}

// previewRecordRows returns the bounded preview of the top ranked rows: the projected columns, their cells
// (strings capped) and their statuses.
func previewRecordRows(frame *dataframe.Frame, indexes []int, ordered *recordRanking) (columns []dataframe.Column, rows [][]any, statuses []string) {
	columns = make([]dataframe.Column, 0, len(indexes))
	for _, index := range indexes {
		columns = append(columns, frame.Columns[index])
	}
	shown := ordered.shown[:min(len(ordered.shown), recordRankMaxRows)]
	rows = make([][]any, 0, len(shown))
	statuses = make([]string, 0, len(shown))
	for _, position := range shown {
		cells := make([]any, 0, len(indexes))
		for _, index := range indexes {
			var cell any
			if index < len(frame.Rows[position]) {
				cell = frame.Rows[position][index]
			}
			if text, isText := cell.(string); isText {
				capped, _ := dashboardText(text, recordRankMaxText)
				cell = capped
			}
			cells = append(cells, cell)
		}
		rows = append(rows, cells)
		statuses = append(statuses, ordered.levels[position])
	}
	return columns, rows, statuses
}

// rankDashboardRecords ranks a record table's loaded frame for query_dashboard. It returns the ranking, the
// source position of the worst row that declares a status and that status. The level is empty when no row
// declares one, and the position is -1. An invalid rank returns a ranking with a reason and no counts.
func rankDashboardRecords(frame *dataframe.Frame, table *dashboardRankedTable) (ranking DashboardRecordRanking, worst int, level string) {
	rank := table.rank
	ranking = DashboardRecordRanking{Basis: recordRankBasis, Status: rank.Status, Value: rank.Value, Order: rank.Order, Evaluated: len(frame.Rows)}
	if ranking.Order == "" {
		ranking.Order = "descending"
	}
	ranking.Limit = rank.Limit
	if table.invalid != "" {
		ranking.Partial, ranking.Reason = true, table.invalid
		return ranking, -1, ""
	}
	if reason := recordRankError(frame, rank, table.styles, table.thresholds); reason != "" {
		ranking.Partial, ranking.Reason = true, reason
		return ranking, -1, ""
	}
	ordered := rankRecordRows(frame, frame.Rows, rank, table.styles, table.thresholds)
	ranking.Counts = ordered.counts
	if ordered.hidden.Rows > 0 {
		hidden := ordered.hidden
		ranking.Hidden = &hidden
	}
	if frame.Truncated {
		ranking.Partial, ranking.Reason = true, recordRankReasonTruncated
	}
	ranking.Columns, ranking.Rows, ranking.Statuses = previewRecordRows(frame, previewColumnIndexes(frame, rank, table.columns), &ordered)
	worst, level = worstRecordRow(ordered.levels)
	return ranking, worst, level
}
