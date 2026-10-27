package postgresql

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/benebsworth/paprika/internal/dataframe"
)

func readFrame(rows *sql.Rows, limit int) (*dataframe.Frame, error) {
	frame, err := emptyFrame(rows)
	if err != nil {
		return nil, err
	}
	bytes := 0
	for rows.Next() {
		if len(frame.Rows) == limit {
			frame.Truncated = true
			break
		}
		row, rowErr := readRow(rows, frame)
		if rowErr != nil {
			return nil, rowErr
		}
		encoded, marshalErr := json.Marshal(row)
		bytes += len(encoded)
		if marshalErr != nil || bytes > dataframe.MaxBytes {
			return nil, errFrameBounds
		}
		frame.Rows = append(frame.Rows, row)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return nil, fmt.Errorf("read SQL rows: %w", rowsErr)
	}
	if dataframe.Validate(frame) != nil {
		return nil, errFrameBounds
	}
	return frame, nil
}

func emptyFrame(rows *sql.Rows) (*dataframe.Frame, error) {
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, fmt.Errorf("read SQL column types: %w", err)
	}
	if len(types) == 0 || len(types) > dataframe.MaxColumns {
		return nil, errFrameBounds
	}
	frame := &dataframe.Frame{Columns: make([]dataframe.Column, len(types)), Rows: make([][]any, 0)}
	for index, column := range types {
		kind := columnKind(column.DatabaseTypeName())
		if kind == "" {
			return nil, errFrameBounds
		}
		frame.Columns[index] = dataframe.Column{Key: column.Name(), Type: kind}
	}
	if dataframe.Validate(frame) != nil {
		return nil, errFrameBounds
	}
	return frame, nil
}

func columnKind(databaseType string) string {
	switch strings.ToUpper(databaseType) {
	case "BOOL":
		return "boolean"
	case "INT2", "INT4", "INT8", "FLOAT4", "FLOAT8", "OID":
		return "number"
	case "TIMESTAMP", "TIMESTAMPTZ", "DATE":
		return "timestamp"
	case "TEXT", "VARCHAR", "BPCHAR", "CHAR", "NAME", "UUID", "NUMERIC", "DECIMAL", "JSON", "JSONB", "INET", "CIDR":
		return "string"
	default:
		return ""
	}
}

func readRow(rows *sql.Rows, frame *dataframe.Frame) ([]any, error) {
	raw := make([]any, len(frame.Columns))
	targets := make([]any, len(raw))
	for index := range raw {
		targets[index] = &raw[index]
	}
	if err := rows.Scan(targets...); err != nil {
		return nil, fmt.Errorf("scan SQL row: %w", err)
	}
	for index, value := range raw {
		// A bigint outside JavaScript's exact integer range changes the entire
		// column to text, including already-scanned rows. Never round IDs/money.
		if integer, ok := value.(int64); ok && (integer > 9007199254740991 || integer < -9007199254740991) {
			frame.Columns[index].Type = "string"
			for _, previous := range frame.Rows {
				if number, ok := previous[index].(int64); ok {
					previous[index] = strconv.FormatInt(number, 10)
				}
			}
		}
		normalized, err := normalizeCell(value, frame.Columns[index].Type)
		if err != nil {
			return nil, err
		}
		raw[index] = normalized
	}
	return raw, nil
}

func normalizeCell(value any, kind string) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch kind {
	case "number":
		return normalizeNumber(value)
	case "boolean":
		if boolean, ok := value.(bool); ok {
			return boolean, nil
		}
	case "timestamp":
		if timestamp, ok := value.(time.Time); ok && timestamp.Year() >= 0 && timestamp.Year() <= 9999 {
			return timestamp.UTC().Format(time.RFC3339Nano), nil
		}
	case "string":
		return normalizeString(value)
	}
	return nil, errFrameBounds
}

func normalizeNumber(value any) (any, error) {
	switch number := value.(type) {
	case int64:
		return number, nil
	case float64:
		if !math.IsNaN(number) && !math.IsInf(number, 0) && math.Abs(number) <= 9007199254740991 {
			return number, nil
		}
	}
	return nil, errFrameBounds
}

func normalizeString(value any) (any, error) {
	var text string
	switch raw := value.(type) {
	case string:
		text = raw
	case []byte:
		text = string(raw)
	case int64:
		text = strconv.FormatInt(raw, 10)
	default:
		return nil, errFrameBounds
	}
	if len(text) > dataframe.MaxCellBytes || !utf8.ValidString(text) {
		return nil, errFrameBounds
	}
	return text, nil
}

func inferProjection(frame *dataframe.Frame) (dataframe.Projection, error) {
	projection := dataframe.Projection{}
	timestamp, err := inferTime(frame.Columns)
	if err != nil {
		return projection, err
	}
	projection.Time = timestamp
	numeric := make([]string, 0)
	for _, column := range frame.Columns {
		switch column.Type {
		case "number":
			numeric = append(numeric, column.Key)
			if column.Key == "value" {
				projection.Value = column.Key
			}
		case "string":
			projection.Labels = append(projection.Labels, column.Key)
		}
	}
	if projection.Value == "" {
		if len(numeric) != 1 {
			return projection, errors.New("SQL metrics need a value or sole numeric column; cast exact decimals to double precision explicitly or specify projection")
		}
		projection.Value = numeric[0]
	}
	return projection, nil
}

func inferTime(columns []dataframe.Column) (string, error) {
	var timestamp string
	for _, column := range columns {
		if column.Type != "timestamp" {
			continue
		}
		if column.Key != "time" && column.Key != "timestamp" && column.Key != "date" {
			continue
		}
		if timestamp != "" {
			return "", errors.New("SQL metric time is ambiguous; provide an explicit projection")
		}
		timestamp = column.Key
	}
	return timestamp, nil
}
