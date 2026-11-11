package checkwire

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

func TestMarshalIsCompactAndStable(t *testing.T) {
	report := &insightsv1.CheckReport{Issues: []*insightsv1.CheckFinding{{RuleId: "schema.widget.layout", Severity: insightsv1.Severity_SEVERITY_ERROR}}, Total: 1}
	first, err := Marshal(report)
	require.NoError(t, err)
	require.NotContains(t, string(first), " ")
	require.JSONEq(t, `{"issues":[{"ruleId":"schema.widget.layout","severity":"SEVERITY_ERROR","source":"SOURCE_UNSPECIFIED","widgetId":"","pointer":"","message":"","fix":""}],"total":1,"truncated":false}`, string(first))
	for i := 0; i < 20; i++ {
		again, err := Marshal(report)
		require.NoError(t, err)
		require.Equal(t, string(first), string(again))
	}
}

func TestBoundCutsTextAndDropsOverlongLocators(t *testing.T) {
	bounded := Bound(&insightsv1.CheckFinding{
		RuleId:   strings.Repeat("r", 300),
		WidgetId: strings.Repeat("w", 200),
		Pointer:  "/widgets/0/" + strings.Repeat("p", 300),
		Message:  strings.Repeat("é", 500),
		Fix:      strings.Repeat("f", 500),
	})
	require.Len(t, bounded.GetRuleId(), MaxRuleIDBytes)
	require.Empty(t, bounded.GetWidgetId())
	require.Empty(t, bounded.GetPointer(), "a cut pointer would name the wrong node")
	require.Equal(t, MaxMessageRunes, utf8.RuneCountInString(bounded.GetMessage()))
	require.Equal(t, MaxMessageRunes, utf8.RuneCountInString(bounded.GetFix()))
	require.True(t, utf8.ValidString(bounded.GetMessage()))
	require.True(t, utf8.ValidString(bounded.GetRuleId()))
}

func TestBoundKeepsRuleIDValidUTF8(t *testing.T) {
	bounded := Bound(&insightsv1.CheckFinding{RuleId: strings.Repeat("é", 50)})
	require.True(t, utf8.ValidString(bounded.GetRuleId()))
	require.LessOrEqual(t, len(bounded.GetRuleId()), MaxRuleIDBytes)
}

func TestPrintableEscapesControlAndFormatCharacters(t *testing.T) {
	require.Equal(t, `a\u000Ab\u000Dc\u0009d`, Printable("a\nb\rc\td"))
	require.Equal(t, `x\u202EY\u2028z`, Printable("x\u202eY\u2028z"))
	require.Equal(t, "plain é text", Printable("plain é text"))
}

func TestCountSaturates(t *testing.T) {
	require.Equal(t, uint32(0), Count(-1))
	require.Equal(t, uint32(7), Count(7))
}
