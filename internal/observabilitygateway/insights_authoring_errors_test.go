package observabilitygateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
	"google.golang.org/genproto/googleapis/rpc/errdetails"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

func detailValues(t *testing.T, err error) []any {
	t.Helper()
	var ce *connect.Error
	require.True(t, errors.As(err, &ce))
	values := make([]any, 0, len(ce.Details()))
	for _, detail := range ce.Details() {
		message, valueErr := detail.Value()
		require.NoError(t, valueErr)
		values = append(values, message)
	}
	return values
}

func TestInsightsStatusErrorCarriesBoundedIssues(t *testing.T) {
	issues := make([]json.RawMessage, 0, 41)
	for i := range 40 {
		issues = append(issues, json.RawMessage(fmt.Sprintf(`{"ruleId":"schema.widget.layout","severity":"SEVERITY_ERROR","source":"SOURCE_SCHEMA","widgetId":"w%02d","pointer":"/widgets/%d/layout","message":"widget layout is outside the dashboard grid"}`, i, i)))
	}
	issues = append(issues, json.RawMessage(`{"ruleId":"schema.widget","severity":"SEVERITY_ERROR","source":"SOURCE_SCHEMA","message":"`+strings.Repeat("é", 2000)+`","evil":"upstream field"}`))
	body, err := json.Marshal(map[string]any{"error": "widget layout is outside the dashboard grid", "issues": issues, "total": 41})
	require.NoError(t, err)

	got := insightsStatusError(http.StatusBadRequest, body, nil)
	require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(got))
	require.Equal(t, "widget layout is outside the dashboard grid", got.Message())
	values := detailValues(t, got)
	require.Len(t, values, 1)
	report, ok := values[0].(*insightsv1.CheckReport)
	require.True(t, ok)
	require.Len(t, report.GetIssues(), checkwire.MaxIssues)
	require.Equal(t, uint32(41), report.GetTotal())
	require.True(t, report.GetTruncated())
	require.Equal(t, "/widgets/0/layout", report.GetIssues()[0].GetPointer())
	require.Equal(t, "w00", report.GetIssues()[0].GetWidgetId())
	require.Empty(t, report.GetIssues()[0].GetFix())

	malformed := insightsStatusError(http.StatusBadRequest, []byte(`{"error":"x","issues":[{"pointer":"/widgets/0"}]`), nil)
	require.Empty(t, detailValues(t, malformed))
}

func TestInsightsStatusErrorTruncatesLongFindingText(t *testing.T) {
	body := []byte(`{"error":"bad","issues":[{"ruleId":"schema.widget","severity":"SEVERITY_ERROR","source":"SOURCE_SCHEMA","pointer":"` + strings.Repeat("p", 300) + `","message":"` + strings.Repeat("m", 1000) + `"}],"total":1}`)
	values := detailValues(t, insightsStatusError(http.StatusBadRequest, body, nil))
	report, ok := values[0].(*insightsv1.CheckReport)
	require.True(t, ok)
	finding := report.GetIssues()[0]
	require.Len(t, finding.GetMessage(), checkwire.MaxMessageRunes)
	require.Empty(t, finding.GetPointer(), "an over-long pointer is dropped rather than cut")
}

func TestInsightsStatusErrorCarriesOnlyNamedRetryDelays(t *testing.T) {
	throttled := http.Header{}
	throttled.Set("Retry-After", "3")
	values := detailValues(t, insightsStatusError(http.StatusTooManyRequests, []byte(`{"error":"too many"}`), throttled))
	require.Len(t, values, 1)
	retry, ok := values[0].(*errdetails.RetryInfo)
	require.True(t, ok)
	require.Equal(t, 3*time.Second, retry.GetRetryDelay().AsDuration())

	for _, value := range []string{"", "Wed, 21 Oct 2026 07:28:00 GMT", "0", "99999"} {
		header := http.Header{}
		if value != "" {
			header.Set("Retry-After", value)
		}
		require.Empty(t, detailValues(t, insightsStatusError(http.StatusTooManyRequests, nil, header)), value)
	}
	internal := http.Header{}
	internal.Set("Retry-After", "5")
	require.Empty(t, detailValues(t, insightsStatusError(http.StatusInternalServerError, []byte("secret upstream body"), internal)))
	require.Equal(t, "insights request failed", insightsStatusError(http.StatusInternalServerError, []byte("secret upstream body"), internal).Message())
}

func TestInsightsStatusErrorBoundsEveryEchoedField(t *testing.T) {
	body := []byte(`{"error":"bad","issues":[{"ruleId":"` + strings.Repeat("r", 300) + `","severity":"SEVERITY_WARNING","source":"SOURCE_SCHEMA","widgetId":"` + strings.Repeat("w", 200) + `","pointer":"/widgets/0/layout","message":"` + strings.Repeat("m", 500) + `","fix":"` + strings.Repeat("f", 500) + `"}],"total":1}`)
	values := detailValues(t, insightsStatusError(http.StatusBadRequest, body, nil))
	report, ok := values[0].(*insightsv1.CheckReport)
	require.True(t, ok)
	finding := report.GetIssues()[0]
	require.Len(t, finding.GetRuleId(), checkwire.MaxRuleIDBytes)
	require.Empty(t, finding.GetWidgetId())
	require.Equal(t, "/widgets/0/layout", finding.GetPointer())
	require.Len(t, finding.GetMessage(), checkwire.MaxMessageRunes)
	require.Len(t, finding.GetFix(), checkwire.MaxMessageRunes)
	require.Equal(t, insightsv1.Severity_SEVERITY_WARNING, finding.GetSeverity())
}
