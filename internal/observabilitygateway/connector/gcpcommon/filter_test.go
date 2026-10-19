package gcpcommon

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPrepareFilterKeepsCallerInsideScope(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		raw      string
		comments bool
		want     string
		wantErr  bool
	}{
		{name: "empty probe", comments: true},
		{name: "balanced groups", raw: `(severity=ERROR OR severity=INFO)`, comments: true, want: `(severity=ERROR OR severity=INFO)`},
		{name: "quoted parentheses and escapes", raw: `textPayload="(value) -- literal \"quote\" \\"`, comments: true, want: `textPayload="(value) -- literal \"quote\" \\"`},
		{name: "quoted comment marker in Monitoring", raw: `metric.labels.note="-- # (literal)"`, want: `metric.labels.note="-- # (literal)"`},
		{name: "Logging leading and trailing comments", raw: "-- ignored )(\nseverity=ERROR -- ignored \"(\n", comments: true, want: "\nseverity=ERROR \n"},
		{name: "Logging terminal comment", raw: "severity=ERROR -- ignored )(", comments: true, want: "severity=ERROR "},
		{name: "Logging CR comment boundary", raw: "-- ignored (\rseverity=ERROR", comments: true, want: "\rseverity=ERROR"},
		{name: "early close can escape time scope", raw: `severity=ERROR) OR textPayload="never-echo" AND (severity=INFO`, comments: true, wantErr: true},
		{name: "early close can escape project scope", raw: `metric.type="never-echo") OR resource.type="global" AND (metric.type="other"`, wantErr: true},
		{name: "unclosed group", raw: `(textPayload="never-echo"`, comments: true, wantErr: true},
		{name: "unterminated string", raw: `textPayload="never-echo`, comments: true, wantErr: true},
		{name: "unterminated escaped string", raw: `textPayload="never-echo\`, comments: true, wantErr: true},
		{name: "comment cannot spoof group balance", raw: "-- (\nseverity=ERROR) OR textPayload=\"never-echo\" AND (severity=INFO", comments: true, wantErr: true},
		{name: "comment cannot spoof quote balance", raw: "textPayload=\"never-echo -- \"\n", comments: true, wantErr: false, want: "textPayload=\"never-echo -- \"\n"},
		{name: "only a comment is not an expression", raw: "-- never-echo (\"", comments: true, wantErr: true},
		{name: "Monitoring rejects dash comments", raw: `metric.type="never-echo" -- comment`, wantErr: true},
		{name: "Monitoring rejects hash comments", raw: `metric.type="never-echo" # comment`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := PrepareFilter(tt.raw, tt.comments)
			if tt.wantErr {
				require.Error(t, err)
				require.Empty(t, got)
				require.NotContains(t, err.Error(), "never-echo")
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}
