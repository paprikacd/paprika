package metrics

import (
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// signalsReference is the agent-facing catalogue of platform metrics.
const signalsReference = "../../.agents/skills/paprika-dashboard-design/references/paprika-signals.md"

// signalRow is one table row of the reference: Exported, Source and Type cells.
type signalRow struct {
	Exported, Source, Type string
}

// TestSignalsReferenceMatchesDefinedMetrics checks the reference against the
// shared definition scanner in both directions. For every metric definition
// there must be a row whose Exported name, Source name and Type agree with the
// scanner, and every row must match a definition. Labels, units beyond what
// the exported name shows, healthy ranges and PromQL are not checked here.
func TestSignalsReferenceMatchesDefinedMetrics(t *testing.T) {
	defs, err := scanMetricDefinitions("../..")
	require.NoError(t, err)
	require.NotEmpty(t, defs)

	byExported := map[string]metricDefinition{}
	for _, def := range defs {
		if prior, dup := byExported[def.Exported]; dup && prior.Source != def.Source {
			t.Errorf("%s is defined by both %s and %s", def.Exported, prior.Source, def.Source)
		}
		byExported[def.Exported] = def
	}

	rows := readSignalRows(t)
	listed := map[string]signalRow{}
	for _, row := range rows {
		if prior, dup := listed[row.Exported]; dup {
			t.Errorf("%s has two rows (sources %s and %s)", row.Exported, prior.Source, row.Source)
		}
		listed[row.Exported] = row
	}

	var missing, stale, mismatched []string
	for exported, def := range byExported {
		row, ok := listed[exported]
		if !ok {
			missing = append(missing, exported+" (source "+def.Source+", "+def.File+")")
			continue
		}
		if row.Source != def.Source {
			mismatched = append(mismatched, exported+": Source column "+row.Source+", defined as "+def.Source)
		}
		if row.Type != def.Kind {
			mismatched = append(mismatched, exported+": Type column "+row.Type+", defined as "+def.Kind)
		}
	}
	for exported := range listed {
		if _, ok := byExported[exported]; !ok {
			stale = append(stale, exported)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	sort.Strings(mismatched)
	require.Empty(t, missing, "defined in Go but missing from %s", signalsReference)
	require.Empty(t, stale, "listed in %s but no longer defined in internal/ or cmd/", signalsReference)
	require.Empty(t, mismatched, "rows disagree with the definitions")
}

// readSignalRows parses the table rows of the reference. PromQL cells escape
// their pipes as \|, so only the first three cells are read.
func readSignalRows(t *testing.T) []signalRow {
	t.Helper()
	body, err := os.ReadFile(signalsReference)
	require.NoError(t, err)
	var rows []signalRow
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		cells := strings.Split(line, "|")
		require.GreaterOrEqual(t, len(cells), 8, "table row must have seven cells: %s", line)
		rows = append(rows, signalRow{
			Exported: strings.Trim(strings.TrimSpace(cells[1]), "`"),
			Source:   strings.Trim(strings.TrimSpace(cells[2]), "`"),
			Type:     strings.TrimSpace(cells[3]),
		})
	}
	require.NotEmpty(t, rows, "no table rows found in %s", signalsReference)
	return rows
}
