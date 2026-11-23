package observabilitygateway

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A metrics signal whose step differs from the range's names its own step in the
// compact text. A signal at the range step names none.
func TestDashboardQueryTextNamesOnlyDifferingSignalSteps(t *testing.T) {
	const fixture = `{"schemaVersion":1,"dashboard":{"id":"steps","title":"Steps","etag":"v1"},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":15},"variables":{},"widgets":[{"id":"a","title":"A","type":"stat","unit":"","signalId":"q1"},{"id":"b","title":"B","type":"stat","unit":"","signalId":"q2"}],"savedQueries":[],"signals":[{"id":"q1","kind":"metrics","providerId":"fine","state":"ok","stepSeconds":30},{"id":"q2","kind":"metrics","providerId":"default","state":"ok"}],"queryCount":{"planned":2,"executed":2,"deduplicated":0},"state":"ok","attention":{"basis":"x","widgets":2,"checked":2,"critical":0,"warning":0,"failed":0,"stale":0}}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	var fine, defaults string
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "q1 "):
			fine = line
		case strings.HasPrefix(line, "q2 "):
			defaults = line
		}
	}
	require.Contains(t, fine, "; step=30s")
	require.NotContains(t, defaults, "step=")
}
