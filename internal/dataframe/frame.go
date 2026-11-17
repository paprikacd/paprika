// Package dataframe defines bounded, typed tabular query results shared by
// application/SQL connectors and Insights. Cells are scalars, never opaque JSON.
package dataframe

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"slices"
	"strconv"
	"time"
)

const (
	MaxRows      = 1000
	MaxColumns   = 64
	MaxCellBytes = 16 << 10
	MaxBytes     = 4 << 20
)

type Column struct {
	Key   string `json:"key"`
	Label string `json:"label,omitempty"`
	Type  string `json:"type"`
	Unit  string `json:"unit,omitempty"`
}

type Frame struct {
	Columns   []Column `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated,omitempty"`
}

// Projection explicitly selects the numeric observation and its dimensions.
// Time names an RFC3339 timestamp column; without it, the query evaluation time
// is used. It never manufactures history for an inventory or summary response.
type Projection struct {
	Value  string   `json:"value"`
	Time   string   `json:"time,omitempty"`
	Labels []string `json:"labels,omitempty"`
}

func Validate(frame *Frame) error {
	if !withinFrameBounds(frame) {
		return errors.New("record frame exceeds its row or column bounds")
	}
	seen := make(map[string]bool, len(frame.Columns))
	for _, column := range frame.Columns {
		if err := validateColumn(column, seen); err != nil {
			return err
		}
		seen[column.Key] = true
	}
	for _, row := range frame.Rows {
		if err := validateRow(frame.Columns, row); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(frame)
	if err != nil || len(encoded) > MaxBytes {
		return errors.New("record frame exceeds its response size limit")
	}
	return nil
}

func withinFrameBounds(frame *Frame) bool {
	return frame != nil && len(frame.Columns) > 0 && len(frame.Columns) <= MaxColumns && frame.Rows != nil && len(frame.Rows) <= MaxRows
}

func validateRow(columns []Column, row []any) error {
	if len(row) != len(columns) {
		return errors.New("record row does not match its columns")
	}
	for index, cell := range row {
		if err := validateCell(columns[index].Type, cell); err != nil {
			return err
		}
	}
	return nil
}

func validateColumn(column Column, seen map[string]bool) error {
	if column.Key == "" || len(column.Key) > 128 || seen[column.Key] || len(column.Label) > 256 || len(column.Unit) > 24 {
		return errors.New("record columns require unique bounded keys and labels")
	}
	if slices.Contains([]string{"__proto__", "constructor", "prototype"}, column.Key) {
		return errors.New("record column key is reserved")
	}
	if !slices.Contains([]string{"string", "number", "boolean", "timestamp"}, column.Type) {
		return errors.New("record column type is unsupported")
	}
	return nil
}

func validateCell(kind string, cell any) error {
	if cell == nil {
		return nil
	}
	switch kind {
	case "number":
		_, err := Number(cell)
		return err
	case "boolean":
		if _, ok := cell.(bool); ok {
			return nil
		}
	case "string", "timestamp":
		if value, ok := cell.(string); ok && len(value) <= MaxCellBytes {
			if kind == "string" {
				return nil
			}
			if _, err := time.Parse(time.RFC3339Nano, value); err == nil {
				return nil
			}
		}
	}
	return errors.New("record cell does not match its declared type or size")
}

// Number accepts JSON-compatible finite numbers without silently rounding a
// large integer. Connectors should expose exact decimals/large integers as text.
func Number(cell any) (float64, error) {
	value, err := numberValue(cell)
	if err != nil {
		return 0, err
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > 9007199254740991 {
		return 0, errors.New("record number exceeds its finite precision bounds")
	}
	return value, nil
}

func numberValue(cell any) (float64, error) {
	if number, ok := cell.(json.Number); ok {
		value, err := number.Float64()
		if err != nil {
			return 0, errors.New("record number is invalid")
		}
		return value, nil
	}
	value := reflect.ValueOf(cell)
	if value.CanInt() {
		return float64(value.Int()), nil
	}
	if value.CanUint() {
		return float64(value.Uint()), nil
	}
	if value.CanFloat() {
		return value.Float(), nil
	}
	return 0, errors.New("record number has a nonnumeric type")
}

func Decode(raw json.RawMessage) (*Frame, error) {
	if len(raw) > MaxBytes {
		return nil, errors.New("record response is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	var frame Frame
	if err := decoder.Decode(&frame); err != nil {
		return nil, errors.New("record response is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("record response has trailing content")
	}
	if err := Validate(&frame); err != nil {
		return nil, err
	}
	return &frame, nil
}

type projectionIndices struct {
	value, timestamp int
	labels           []int
}

func resolveProjection(frame *Frame, projection Projection) (projectionIndices, error) {
	indices := projectionIndices{value: -1, timestamp: -1}
	byKey := make(map[string]int, len(frame.Columns))
	for i, column := range frame.Columns {
		byKey[column.Key] = i
	}
	value, ok := byKey[projection.Value]
	if !ok || frame.Columns[value].Type != "number" {
		return indices, errors.New("metric projection requires a numeric value column")
	}
	indices.value = value
	if projection.Time != "" {
		index, exists := byKey[projection.Time]
		if !exists || frame.Columns[index].Type != "timestamp" {
			return indices, errors.New("metric time projection requires a timestamp column")
		}
		indices.timestamp = index
	}
	var err error
	indices.labels, err = projectionLabels(projection, byKey)
	return indices, err
}

func projectionLabels(projection Projection, byKey map[string]int) ([]int, error) {
	labels := []int{}
	if len(projection.Labels) > 16 {
		return nil, errors.New("metric projection permits at most 16 labels")
	}
	seen := make(map[string]bool, len(projection.Labels))
	for _, label := range projection.Labels {
		index, exists := byKey[label]
		if !exists || seen[label] || label == projection.Value || label == projection.Time || label == "__name__" {
			return nil, errors.New("metric label projection is invalid")
		}
		seen[label] = true
		labels = append(labels, index)
	}
	return labels, nil
}

type metricSeries struct {
	Metric map[string]string `json:"metric"`
	Values [][2]any          `json:"values"`
}

// Prometheus converts only the explicitly selected numeric column. Null samples
// remain NaN on the wire so the existing normalizer preserves gaps. Duplicate
// observations are rejected rather than inventing an aggregation.
func Prometheus(frame *Frame, projection Projection, end time.Time) (json.RawMessage, error) {
	if err := Validate(frame); err != nil {
		return nil, err
	}
	indices, err := resolveProjection(frame, projection)
	if err != nil {
		return nil, err
	}
	if end.IsZero() {
		end = time.Now().UTC()
	}
	series := make([]metricSeries, 0)
	groups := make(map[string]int)
	observations := make(map[string]bool)
	for _, row := range frame.Rows {
		labels, group, labelErr := metricLabels(frame, row, indices, projection.Value)
		if labelErr != nil {
			return nil, labelErr
		}
		point, pointErr := metricPoint(row, indices, end)
		if pointErr != nil {
			return nil, pointErr
		}
		identity := group + "/" + fmt.Sprint(point[0])
		if observations[identity] {
			return nil, errors.New("metric projection has duplicate observations; select distinct labels or aggregate in the source query")
		}
		observations[identity] = true
		index, exists := groups[group]
		if !exists {
			index = len(series)
			groups[group] = index
			series = append(series, metricSeries{Metric: labels, Values: make([][2]any, 0)})
		}
		series[index].Values = append(series[index].Values, point)
	}
	encoded, err := json.Marshal(struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string         `json:"resultType"`
			Result     []metricSeries `json:"result"`
		} `json:"data"`
		Truncated bool `json:"truncated,omitempty"`
	}{Status: "success", Data: struct {
		ResultType string         `json:"resultType"`
		Result     []metricSeries `json:"result"`
	}{ResultType: "matrix", Result: series}, Truncated: frame.Truncated})
	if err != nil {
		return nil, fmt.Errorf("encode projected metrics: %w", err)
	}
	return encoded, nil
}

func metricLabels(frame *Frame, row []any, indices projectionIndices, name string) (labels map[string]string, identity string, err error) {
	labels = map[string]string{"__name__": name}
	for _, index := range indices.labels {
		if row[index] == nil {
			continue
		}
		labels[frame.Columns[index].Key] = fmt.Sprint(row[index])
	}
	encoded, err := json.Marshal(labels)
	if err != nil {
		return nil, "", fmt.Errorf("encode projected labels: %w", err)
	}
	return labels, string(encoded), nil
}

func metricPoint(row []any, indices projectionIndices, end time.Time) ([2]any, error) {
	timestamp := float64(end.Unix()) + float64(end.Nanosecond())/1e9
	if indices.timestamp >= 0 {
		value, ok := row[indices.timestamp].(string)
		if !ok {
			return [2]any{}, errors.New("metric timestamp cannot be null")
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err != nil {
			return [2]any{}, errors.New("metric timestamp is invalid")
		}
		timestamp = float64(parsed.Unix()) + float64(parsed.Nanosecond())/1e9
	}
	value := "NaN"
	if row[indices.value] != nil {
		number, err := Number(row[indices.value])
		if err != nil {
			return [2]any{}, err
		}
		value = strconv.FormatFloat(number, 'g', -1, 64)
	}
	return [2]any{timestamp, value}, nil
}
