package insights

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
)

// The Go half of docs/design/insights/conformance/contract-differential.json, which the UI test
// contract-differential.test.ts writes from the canonical Zod schema. Every shipped example document and every
// mutation of the base document must get the Zod verdict from three places:
//
//   - validateDashboard, the hand-written Go validator a save runs: always the same verdict.
//   - the published dashboard JSON Schema: never refuses what Zod accepts; refuses what Zod refuses unless the
//     case names a jsonSchemaGap, a refinement JSON Schema cannot carry, which it must then accept (pinned).
//   - pluginConfigProblem, the plugin.config lint, for every built-in plugin widget: always the same verdict.
//
// Regenerate the fixture with `npm run schema:generate` in ui/.

type differentialPlugin struct {
	Widget   string `json:"widget"`
	PluginID string `json:"pluginId"`
	Valid    bool   `json:"valid"`
}

type differentialOp struct {
	Path   string          `json:"path"`
	Value  json.RawMessage `json:"value"`
	JSON   *string         `json:"json"`
	Remove bool            `json:"remove"`
}

type differentialCase struct {
	Name          string               `json:"name"`
	Valid         bool                 `json:"valid"`
	Plugins       []differentialPlugin `json:"plugins"`
	JSONSchemaGap string               `json:"jsonSchemaGap"`
	// JSONSchemaStricter and GoRefuses name the only accepted ways a validator may refuse what Zod accepts.
	JSONSchemaStricter string           `json:"jsonSchemaStricter"`
	GoRefuses          string           `json:"goRefuses"`
	Document           json.RawMessage  `json:"document"`
	Ops                []differentialOp `json:"ops"`
}

type differentialFixture struct {
	Base      json.RawMessage    `json:"base"`
	Documents []differentialCase `json:"documents"`
	Mutations []differentialCase `json:"mutations"`
}

func readDifferentialFixture(t *testing.T) differentialFixture {
	t.Helper()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/contract-differential.json")
	require.NoError(t, err)
	var fixture differentialFixture
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Documents)
	require.NotEmpty(t, fixture.Mutations)
	return fixture
}

func TestContractDifferentialAgreesWithZod(t *testing.T) {
	fixture := readDifferentialFixture(t)
	schema := compileEmbeddedDashboardSchema(t)
	cases := make([]differentialCase, 0, len(fixture.Documents)+len(fixture.Mutations))
	cases = append(cases, fixture.Documents...)
	for _, mutation := range fixture.Mutations {
		document, err := applyDifferentialOps(fixture.Base, mutation.Ops)
		require.NoError(t, err, mutation.Name)
		mutation.Document = document
		cases = append(cases, mutation)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			goErr := validateDashboard(differentialID(tc.Document), tc.Document)
			switch tc.GoRefuses {
			case "":
				require.Equal(t, tc.Valid, goErr == nil, "Zod says valid=%t; validateDashboard: %v", tc.Valid, goErr)
			case "number spelling":
				// JSON.parse reads 2.0 as 2, so Zod cannot see the spelling. Go refuses it and names the member.
				require.ErrorContains(t, goErr, "must be a whole number written without a decimal point or exponent")
			default:
				t.Fatalf("unknown goRefuses %q", tc.GoRefuses)
			}

			decoded, err := jsonschema.UnmarshalJSON(bytes.NewReader(tc.Document))
			require.NoError(t, err)
			schemaErr := schema.Validate(decoded)
			switch {
			case tc.JSONSchemaStricter == "trim":
				// JSON Schema bounds the untrimmed string; Zod and Go bound the trimmed one. Pinned, not endorsed.
				require.Error(t, schemaErr, "the published schema now accepts this trim case; drop jsonSchemaStricter")
			case tc.JSONSchemaStricter != "":
				t.Fatalf("unknown jsonSchemaStricter %q", tc.JSONSchemaStricter)
			case tc.Valid:
				require.NoError(t, schemaErr, "the published schema refuses a document Zod accepts")
			case tc.JSONSchemaGap != "":
				require.NoError(t, schemaErr, "the published schema was expected to accept this %s gap; if it now refuses it, drop the jsonSchemaGap", tc.JSONSchemaGap)
			default:
				require.Error(t, schemaErr, "the published schema accepts a document Zod refuses; name the gap in the mutation if JSON Schema cannot express it")
			}

			require.Equal(t, tc.Plugins, goPluginVerdicts(t, tc.Document), "plugin config verdicts (Zod first, Go second)")
		})
	}
}

// goPluginVerdicts is the Go verdict for each built-in plugin widget the bundle checks, in document order. A widget
// that Go checks but Zod does not list, or the reverse, shows up as a difference.
func goPluginVerdicts(t *testing.T, document json.RawMessage) []differentialPlugin {
	t.Helper()
	var doc struct {
		Widgets []struct {
			ID       any             `json:"id"`
			Type     any             `json:"type"`
			PluginID any             `json:"pluginId"`
			Config   json.RawMessage `json:"config"`
		} `json:"widgets"`
	}
	if json.Unmarshal(document, &doc) != nil {
		return nil
	}
	schemas, err := pluginConfigSchemas()
	require.NoError(t, err)
	verdicts := []differentialPlugin{}
	for _, widget := range doc.Widgets {
		id, _ := widget.ID.(string)
		pluginID, _ := widget.PluginID.(string)
		if widget.Type != "plugin" || id == "" || schemas[pluginID] == nil {
			continue
		}
		_, _, refused := pluginConfigProblem(pluginID, widget.Config)
		verdicts = append(verdicts, differentialPlugin{Widget: id, PluginID: pluginID, Valid: !refused})
	}
	return verdicts
}

func differentialID(document json.RawMessage) string {
	var head struct {
		ID any `json:"id"`
	}
	if json.Unmarshal(document, &head) == nil {
		if id, ok := head.ID.(string); ok {
			return id
		}
	}
	return "contract-base"
}

// applyDifferentialOps applies the fixture's mutations to the base document the way the UI test does. Numbers keep
// their spelling (json.Number), and a json op splices its raw text, so 2.0 reaches the validator as 2.0.
func applyDifferentialOps(base json.RawMessage, ops []differentialOp) (json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(base))
	decoder.UseNumber()
	var document any
	if err := decoder.Decode(&document); err != nil {
		return nil, err
	}
	for _, op := range ops {
		var value any
		switch {
		case op.Remove:
		case op.JSON != nil:
			value = json.RawMessage(*op.JSON)
		default:
			value = op.Value
		}
		var err error
		document, err = setPointer(document, splitPointer(op.Path), value, op.Remove)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", op.Path, err)
		}
	}
	return json.Marshal(document)
}

func splitPointer(pointer string) []string {
	parts := strings.Split(pointer, "/")[1:]
	for i, part := range parts {
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
	}
	return parts
}

func setPointer(node any, path []string, value any, remove bool) (any, error) {
	if len(path) == 0 {
		return value, nil
	}
	key, rest := path[0], path[1:]
	switch current := node.(type) {
	case map[string]any:
		if len(rest) == 0 {
			if remove {
				if _, ok := current[key]; !ok {
					return nil, fmt.Errorf("member %q does not exist", key)
				}
				delete(current, key)
				return current, nil
			}
			current[key] = value
			return current, nil
		}
		child, ok := current[key]
		if !ok {
			return nil, fmt.Errorf("member %q does not exist", key)
		}
		updated, err := setPointer(child, rest, value, remove)
		current[key] = updated
		return current, err
	case []any:
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 || index > len(current) {
			return nil, fmt.Errorf("index %q is outside its array", key)
		}
		if len(rest) == 0 {
			switch {
			case remove:
				return append(current[:index], current[index+1:]...), nil
			case index == len(current):
				return append(current, value), nil
			}
			current[index] = value
			return current, nil
		}
		if index == len(current) {
			return nil, fmt.Errorf("index %q is outside its array", key)
		}
		updated, err := setPointer(current[index], rest, value, remove)
		current[index] = updated
		return current, err
	}
	return nil, fmt.Errorf("%q is not inside an object or array", key)
}

// A refused plugin config on a schema-valid document is the plugin.config error a save returns, at the member's pointer
// inside the widget's config; an accepted one raises no such error.
func TestContractDifferentialPluginVerdictsAreSaveErrors(t *testing.T) {
	fixture := readDifferentialFixture(t)
	for _, mutation := range fixture.Mutations {
		if !mutation.Valid {
			continue
		}
		document, err := applyDifferentialOps(fixture.Base, mutation.Ops)
		require.NoError(t, err)
		var refusedWidgets []string
		for _, plugin := range mutation.Plugins {
			if !plugin.Valid {
				refusedWidgets = append(refusedWidgets, plugin.Widget)
			}
		}
		var errored []string
		for _, finding := range CheckDocument(document) {
			if finding.GetRuleId() == pluginConfigRuleID && finding.GetSeverity() == errorSeverity {
				require.Contains(t, finding.GetPointer(), "/config", mutation.Name)
				errored = append(errored, finding.GetWidgetId())
			}
		}
		sort.Strings(refusedWidgets)
		sort.Strings(errored)
		require.Equal(t, refusedWidgets, errored, mutation.Name)
	}
}
