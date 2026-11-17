// Package checkwire is the one wire form for dashboard check findings. Every
// producer and consumer marshals through it, so the HTTP API, the Observe
// gateway and the MCP tool results agree on bytes and on field bounds.
package checkwire

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// Bounds on what a consumer accepts from a finding. A finding is copied into
// responses and tool errors, so none of its fields may grow with the document.
const (
	// MaxIssues caps the issue list in any response or tool result.
	MaxIssues = 32
	// MaxRuleIDBytes caps rule ids, which are short fixed names.
	MaxRuleIDBytes = 80
	// MaxWidgetIDBytes caps widget ids, which the store already limits.
	MaxWidgetIDBytes = 80
	// MaxPointerBytes caps JSON pointers. A pointer longer than this is dropped,
	// because a cut pointer would name the wrong node.
	MaxPointerBytes = 256
	// MaxMessageRunes caps messages and fix text.
	MaxMessageRunes = 200
	// MaxDryRunVariables caps the variable values a dry run with execute takes.
	MaxDryRunVariables = 20
	// MaxDryRunVariableUnits caps one variable value in UTF-16 code units, which is
	// how the dashboard counts it. A unit is at most six bytes once JSON escapes it
	// (a control, <, > or & written as \uXXXX), so the envelope allowance is sized
	// on that worst case, not on the typical one.
	MaxDryRunVariableUnits = 1024
	// MaxDryRunNameUnits caps a variable name in UTF-16 code units.
	MaxDryRunNameUnits = 64
	// DryRunEnvelopeBytes is the room a dry-run request needs beyond its document:
	// every variable at the worst escaped size, the member syntax around each one,
	// and a fixed allowance for the envelope itself.
	DryRunEnvelopeBytes = MaxDryRunVariables*(6*(MaxDryRunVariableUnits+MaxDryRunNameUnits)+40) + 4<<10
)

var options = protojson.MarshalOptions{EmitUnpopulated: true}

// Marshal encodes a message as protojson with every field present, then
// compacts it. protojson adds random spacing on purpose, so compacting is what
// makes the bytes stable across calls.
func Marshal(m proto.Message) ([]byte, error) {
	data, err := options.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("marshal check finding: %w", err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return nil, fmt.Errorf("compact check finding: %w", err)
	}
	return compact.Bytes(), nil
}

// Unmarshal decodes protojson, ignoring fields this version does not define.
func Unmarshal(data []byte, m proto.Message) error {
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, m); err != nil {
		return fmt.Errorf("unmarshal check finding: %w", err)
	}
	return nil
}

// Count converts a length to the uint32 a report carries, saturating rather
// than wrapping for any value a response could reach.
func Count(n int) uint32 {
	if n < 0 {
		return 0
	}
	return uint32(min(n, math.MaxUint32))
}

// Bound returns a copy of finding with every field inside the wire bounds.
// Producer text is never trusted to be short: a field that does not fit is cut
// (messages, fix text, rule ids) or dropped (pointers, widget ids).
func Bound(finding *insightsv1.CheckFinding) *insightsv1.CheckFinding {
	bounded, ok := proto.Clone(finding).(*insightsv1.CheckFinding)
	if !ok {
		return &insightsv1.CheckFinding{}
	}
	bounded.RuleId = truncateBytes(bounded.GetRuleId(), MaxRuleIDBytes)
	if len(bounded.GetPointer()) > MaxPointerBytes {
		bounded.Pointer = ""
	}
	if len(bounded.GetWidgetId()) > MaxWidgetIDBytes {
		bounded.WidgetId = ""
	}
	bounded.Message = truncateRunes(bounded.GetMessage(), MaxMessageRunes)
	bounded.Fix = truncateRunes(bounded.GetFix(), MaxMessageRunes)
	return bounded
}

// Printable makes producer text safe to show a model in plain text. Control
// characters, line and paragraph separators, and format characters such as
// bidirectional overrides are written as \uXXXX escapes, so a submitted key
// cannot start a new line or hide text in the agent-facing output.
func Printable(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsControl(r) || r == ' ' || r == ' ' || unicode.Is(unicode.Cf, r) {
			fmt.Fprintf(&b, "\\u%04X", r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func truncateBytes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}
