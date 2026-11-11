package insights

import (
	"encoding/json"
	"os"
	"testing"
)

// layoutCompactionFixture is the parity fixture the TypeScript compactor
// generates (ui/src/features/insights/layout-compaction.test.ts).
type layoutCompactionFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Columns       int `json:"columns"`
	Cases         []struct {
		Name      string       `json:"name"`
		Widgets   []fixtureBox `json:"widgets"`
		Compacted []fixtureBox `json:"compacted"`
	} `json:"cases"`
}

type fixtureBox struct {
	ID string `json:"id"`
	X  int    `json:"x"`
	Y  int    `json:"y"`
	W  int    `json:"w"`
	H  int    `json:"h"`
}

// TestLayoutCompactionMatchesTheCanvas runs the shared fixtures through the Go
// port. Each expected position was produced by the TypeScript compactor, so this
// test fails if the port and the canvas diverge.
func TestLayoutCompactionMatchesTheCanvas(t *testing.T) {
	data, err := os.ReadFile("../../docs/design/insights/conformance/layout-compaction.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture layoutCompactionFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Columns != canvasColumns {
		t.Fatalf("fixture columns = %d, want %d", fixture.Columns, canvasColumns)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("no compaction cases")
	}
	for _, tc := range fixture.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			input := make([]gridBox, len(tc.Widgets))
			for i, box := range tc.Widgets {
				input[i] = gridBox{x: box.X, y: box.Y, w: box.W, h: box.H}
			}
			got := compactBoxes(input)
			if len(got) != len(tc.Compacted) {
				t.Fatalf("got %d boxes, want %d", len(got), len(tc.Compacted))
			}
			for i, want := range tc.Compacted {
				if got[i] != (gridBox{x: want.X, y: want.Y, w: want.W, h: want.H}) {
					t.Fatalf("%s: got %+v, want %+v", want.ID, got[i], want)
				}
			}
		})
	}
}
