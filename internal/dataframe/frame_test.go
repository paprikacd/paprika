package dataframe

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func testFrame() *Frame {
	return &Frame{Columns: []Column{{Key: "service", Type: "string"}, {Key: "time", Type: "timestamp"}, {Key: "value", Type: "number"}}, Rows: [][]any{{"api", "2026-10-27T00:00:00Z", float64(0)}, {"api", "2026-10-27T00:01:00Z", nil}}}
}

func TestFrameRejectsInvalidOrUnboundedData(t *testing.T) {
	cases := map[string]func(*Frame){
		"missing rows":        func(f *Frame) { f.Rows = nil },
		"extra cells":         func(f *Frame) { f.Rows[0] = append(f.Rows[0], "extra") },
		"object cell":         func(f *Frame) { f.Rows[0][0] = map[string]string{"unexpected": "value"} },
		"wrong type":          func(f *Frame) { f.Rows[0][2] = "12" },
		"duplicate column":    func(f *Frame) { f.Columns[1].Key = "service" },
		"reserved column":     func(f *Frame) { f.Columns[0].Key = "__proto__" },
		"unknown column type": func(f *Frame) { f.Columns[0].Type = "json" },
		"bad timestamp":       func(f *Frame) { f.Rows[0][1] = "yesterday" },
		"infinite":            func(f *Frame) { f.Rows[0][2] = math.Inf(1) },
		"nan":                 func(f *Frame) { f.Rows[0][2] = math.NaN() },
		"unsafe integer":      func(f *Frame) { f.Rows[0][2] = int64(9007199254740993) },
		"large cell":          func(f *Frame) { f.Rows[0][0] = strings.Repeat("a", MaxCellBytes+1) },
		"many rows": func(f *Frame) {
			for len(f.Rows) <= MaxRows {
				f.Rows = append(f.Rows, f.Rows[0])
			}
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			frame := testFrame()
			change(frame)
			if err := Validate(frame); err == nil {
				t.Fatal("accepted invalid frame")
			}
		})
	}
}

func TestDecodePreservesNullZeroAndExactText(t *testing.T) {
	raw := json.RawMessage(`{"columns":[{"key":"exact","type":"string"},{"key":"value","type":"number"},{"key":"active","type":"boolean"}],"rows":[["9007199254740993",0,false],[null,null,null]],"truncated":true}`)
	frame, err := Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !frame.Truncated || frame.Rows[0][0] != "9007199254740993" || frame.Rows[0][1] != json.Number("0") || frame.Rows[0][2] != false || frame.Rows[1][1] != nil {
		t.Fatalf("changed cell semantics: %#v", frame)
	}
	for _, suffix := range []string{`{}`, `null`, `extra`} {
		if _, err := Decode(append(append(json.RawMessage{}, raw...), suffix...)); err == nil {
			t.Fatal("accepted trailing content")
		}
	}
	if _, err := Decode(json.RawMessage(`{"columns":[],"rows":[],"unexpected":true}`)); err == nil {
		t.Fatal("accepted unknown fields")
	}
}

func TestProjectionPreservesGapsAndRejectsAmbiguity(t *testing.T) {
	frame := testFrame()
	frame.Truncated = true
	projection := Projection{Value: "value", Time: "time", Labels: []string{"service"}}
	raw, err := Prometheus(frame, projection, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Truncated bool `json:"truncated"`
		Data      struct {
			Result []metricSeries `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if !result.Truncated || len(result.Data.Result) != 1 {
		t.Fatalf("wrong series: %s", raw)
	}
	series := result.Data.Result[0]
	first, firstOK := series.Values[0][0].(float64)
	last, lastOK := series.Values[1][0].(float64)
	if !firstOK || !lastOK {
		t.Fatal("metric timestamps are not numbers")
	}
	if series.Metric["service"] != "api" || series.Values[0][1] != "0" || series.Values[1][1] != "NaN" || last-first != 60 {
		t.Fatalf("changed observations: %s", raw)
	}
	frame.Rows = append(frame.Rows, frame.Rows[0])
	if _, err := Prometheus(frame, projection, time.Time{}); err == nil {
		t.Fatal("silently aggregated duplicate observations")
	}
	for _, invalid := range []Projection{{Value: "service"}, {Value: "value", Time: "service"}, {Value: "value", Labels: []string{"service", "service"}}, {Value: "value", Labels: []string{"missing"}}} {
		if _, err := Prometheus(testFrame(), invalid, time.Time{}); err == nil {
			t.Fatal("accepted invalid projection")
		}
	}
}

func TestSnapshotProjectionUsesEvaluationTime(t *testing.T) {
	frame := testFrame()
	frame.Rows = frame.Rows[:1]
	end := time.Date(2026, 10, 27, 12, 30, 0, 0, time.UTC)
	raw, err := Prometheus(frame, Projection{Value: "value"}, end)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Data struct {
			Result []metricSeries `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.Result[0].Values[0][0] != float64(end.Unix()) {
		t.Fatalf("invented historical timestamp: %s", raw)
	}
}
