package observabilitygateway

// The same cases run against the TypeScript module ui/src/features/insights/dashboard-patch.ts
// (dashboard-patch.test.ts). Keep the two in step through docs/design/insights/conformance/dashboard-patch.json.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"
)

type dashboardPatchConformance struct {
	ETag  string `json:"etag"`
	Cases []struct {
		Name      string          `json:"name"`
		Document  json.RawMessage `json:"document"`
		Arguments json.RawMessage `json:"arguments"`
		Expect    struct {
			Document   json.RawMessage `json:"document"`
			Placements json.RawMessage `json:"placements"`
			Error      string          `json:"error"`
		} `json:"expect"`
	} `json:"cases"`
}

func TestInsightsPatchConformanceFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "docs", "design", "insights", "conformance", "dashboard-patch.json"))
	require.NoError(t, err)
	var fixture dashboardPatchConformance
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.GreaterOrEqual(t, len(fixture.Cases), 26)

	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			arguments := map[string]json.RawMessage{}
			require.NoError(t, json.Unmarshal(testCase.Arguments, &arguments))
			arguments["id"] = json.RawMessage(`"demo"`)
			etag, err := json.Marshal(fixture.ETag)
			require.NoError(t, err)
			arguments["etag"] = etag
			input, err := json.Marshal(arguments)
			require.NoError(t, err)

			args, err := decodeInsightsPatchArgs(input)
			if err == nil {
				err = validateInsightsPatchArgs("dashboards", args)
			}
			var document json.RawMessage
			var placements []insightsPlacement
			if err == nil {
				document, placements, err = applyInsightsPatch(context.Background(), testCase.Document, "dashboards", args)
			}

			if testCase.Expect.Error != "" {
				require.Error(t, err)
				require.Equal(t, testCase.Expect.Error, connect.CodeOf(err).String())
				return
			}
			require.NoError(t, err)
			require.True(t, sameInsightsJSON(testCase.Expect.Document, document), "document differs: %s", document)

			if placements == nil {
				placements = []insightsPlacement{}
			}
			got, err := json.Marshal(placements)
			require.NoError(t, err)
			want := testCase.Expect.Placements
			if len(want) == 0 || string(want) == "null" {
				want = json.RawMessage("[]")
			}
			require.True(t, sameInsightsJSON(want, got), "placements differ: %s", got)
		})
	}
}
