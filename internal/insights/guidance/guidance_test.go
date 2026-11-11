package guidance

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The UI builds its Build-with-AI prompt from a TypeScript copy of these rules.
// Compare exact quoted lines so the two copies cannot drift silently.
func TestDashboardAuthoringGuidanceMatchesUI(t *testing.T) {
	source, err := os.ReadFile("../../../ui/src/features/insights/authoring-guidance.ts")
	require.NoError(t, err)
	text := string(source)
	lines := DashboardAuthoring()
	require.GreaterOrEqual(t, len(lines), 8)
	require.LessOrEqual(t, len(lines), 14)
	for _, line := range lines {
		require.NotContains(t, line, `"`, "guidance lines must stay quote-free for the parity check")
		require.Contains(t, text, `"`+line+`",`, "UI guidance is missing or changed: %s", line)
	}
	entries := regexp.MustCompile(`(?m)^  "[^\n]*",$`).FindAllString(text, -1)
	require.Len(t, entries, len(lines), "UI guidance must contain exactly the Go entries")
}

func TestDashboardAuthoringGuidanceIsImperativeAndCopied(t *testing.T) {
	first := DashboardAuthoring()
	first[0] = "mutated"
	require.False(t, strings.HasPrefix(DashboardAuthoring()[0], "mutated"), "callers must not mutate the shared rules")
}
