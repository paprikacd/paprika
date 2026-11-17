package main

import (
	"strings"
	"testing"
)

// The render help says that Secret values are redacted and that the output is not
// meant to be applied with kubectl.
func TestRenderHelpSaysSecretValuesAreRedacted(t *testing.T) {
	t.Parallel()
	cmd := newRenderCmd(t.Context(), nil, new(string))
	for _, want := range []string{"Secret values are redacted", "<redacted>", "not meant to be applied with kubectl"} {
		if !strings.Contains(cmd.Long, want) {
			t.Fatalf("render help %q does not contain %q", cmd.Long, want)
		}
	}
}
